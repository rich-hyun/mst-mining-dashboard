// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMSTStaking} from "./interfaces/IMSTStaking.sol";

/// @title  MSTMiningReward
/// @notice 등록된 장치가 제출한 작업증명(share)을 검증하고, 운영 지갑이 미리 넣어 둔 보상 풀에서
///         고정 규칙에 따라 네이티브 MST를 지급한다. 컨트랙트는 MST를 새로 발행하지 않는다.
/// @dev    ERC-918 방식을 참고했다.
///         - challenge = keccak256(직전 블록 해시, 에폭 번호, 이 컨트랙트 주소)
///         - digest    = keccak256(challenge ‖ 채굴자 주소 ‖ nonce) — 채굴자 주소를 넣어 남의 nonce 가로채기를 막는다
///         - digest <= miningTarget 이면 유효한 share
///         난이도는 에폭마다 "평균 제출 간격 / 목표 간격" 비율로 조절한다(에폭 단위 단순 이동평균, 1회 최대 4배).
contract MSTMiningReward is AccessControl, Pausable, ReentrancyGuard {
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");
    bytes32 public constant PARAMS_ROLE = keccak256("PARAMS_ROLE");

    /// @dev 한 번의 조절에서 target이 바뀔 수 있는 최대 배수
    uint256 private constant MAX_ADJUST_FACTOR = 4;

    enum RewardMode {
        Wallet, // 지갑으로 즉시 받기
        Stake // 스테이킹 컨트랙트에 자동 예치
    }

    enum WithheldReason {
        PoolDepleted,
        DailyCap,
        EpochCap
    }

    struct Params {
        uint256 rewardPerShare; // 제출 1건당 보상 (wei)
        uint256 dailyCapPerWallet; // 지갑별 하루(UTC) 지급 상한 (wei)
        uint256 epochCap; // 에폭별 총 지급 상한 (wei)
        uint64 targetInterval; // 네트워크 전체 목표 제출 간격 (초)
        uint32 sharesPerEpoch; // 에폭 하나에 담는 share 수 (= 난이도 조절 주기)
        uint64 minShareInterval; // 같은 지갑의 연속 제출 최소 간격 (초)
    }

    IMSTStaking public staking;
    bool public stakingEnabled;

    Params public params;

    uint256 public epoch;
    bytes32 public challenge;
    uint256 public miningTarget;
    uint256 public minTarget; // 가장 어려운 난이도
    uint256 public maxTarget; // 가장 쉬운 난이도
    uint256 public epochStartedAt;
    uint256 public epochShares;
    uint256 public epochPaid;

    uint256 public registeredCount;
    uint256 public totalAcceptedShares;
    uint256 public totalRewarded;

    mapping(address => bool) public isRegistered;
    mapping(address => RewardMode) public rewardMode;
    mapping(address => uint256) public acceptedShares;
    mapping(address => uint256) public rewardedToWallet;
    mapping(address => uint256) public rewardedToStaking;
    mapping(address => uint256) public lastShareAt;
    mapping(address => mapping(uint256 => uint256)) public paidOnDay;
    mapping(bytes32 => bool) public usedDigest;

    event RegistrationRequested(address indexed applicant, string label);
    event DeviceRegistered(address indexed device, string label, address indexed registrar);
    event DeviceUnregistered(address indexed device, address indexed registrar);
    event ShareAccepted(address indexed miner, uint256 nonce, bytes32 hash, uint256 reward);
    event RewardWithheld(address indexed miner, WithheldReason reason, uint256 amount);
    event DifficultyAdjusted(uint256 indexed epoch, uint256 oldTarget, uint256 newTarget, uint256 elapsed, uint256 shares);
    event EpochStarted(uint256 indexed epoch, bytes32 challenge, uint256 miningTarget);
    event PoolFunded(address indexed from, uint256 amount, uint256 balance);
    event PoolWithdrawn(address indexed to, uint256 amount, uint256 balance);
    event ParamsUpdated(Params params);
    event TargetBoundsUpdated(uint256 minTarget, uint256 maxTarget);
    event StakingEnabledUpdated(bool enabled);
    event RewardModeUpdated(address indexed miner, RewardMode mode);
    event StakingContractUpdated(address indexed staking);
    event StakeFallbackToWallet(address indexed miner, uint256 amount);

    error NotRegistered(address miner);
    error AlreadyRegistered(address device);
    error StaleChallenge(bytes32 current, bytes32 given);
    error DigestAboveTarget(bytes32 digest, uint256 miningTarget);
    error DuplicateShare(bytes32 digest);
    error TooSoon(uint256 nextAllowedAt);
    error StakingUnavailable();
    error EpochNotExpired(uint256 expiresAt);
    error InvalidParams();
    error InvalidTarget();
    error TransferFailed();

    constructor(
        address admin,
        address stakingContract,
        Params memory initialParams,
        uint256 initialTarget,
        uint256 minTarget_,
        uint256 maxTarget_
    ) {
        staking = IMSTStaking(stakingContract);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(REGISTRAR_ROLE, admin);
        _grantRole(PARAMS_ROLE, admin);

        _setParams(initialParams);
        _setTargetBounds(minTarget_, maxTarget_);
        if (initialTarget < minTarget_ || initialTarget > maxTarget_) revert InvalidTarget();
        miningTarget = initialTarget;
        _startEpoch();
    }

    // ───────────────────────── 보상 풀 ─────────────────────────

    receive() external payable {
        emit PoolFunded(msg.sender, msg.value, address(this).balance);
    }

    function fundPool() external payable {
        emit PoolFunded(msg.sender, msg.value, address(this).balance);
    }

    function withdrawPool(address payable to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit PoolWithdrawn(to, amount, address(this).balance);
    }

    function poolBalance() external view returns (uint256) {
        return address(this).balance;
    }

    // ───────────────────────── 장치 등록 ─────────────────────────

    /// @notice 참여 신청. 기록만 남기며, 실제 등록은 REGISTRAR_ROLE이 승인해야 한다.
    function requestRegistration(string calldata label) external {
        if (isRegistered[msg.sender]) revert AlreadyRegistered(msg.sender);
        emit RegistrationRequested(msg.sender, label);
    }

    function registerDevice(address device, string calldata label) external onlyRole(REGISTRAR_ROLE) {
        _register(device, label);
    }

    function registerDevices(address[] calldata devices, string[] calldata labels) external onlyRole(REGISTRAR_ROLE) {
        if (devices.length != labels.length) revert InvalidParams();
        for (uint256 i; i < devices.length; ++i) _register(devices[i], labels[i]);
    }

    function unregisterDevice(address device) external onlyRole(REGISTRAR_ROLE) {
        if (!isRegistered[device]) revert NotRegistered(device);
        isRegistered[device] = false;
        --registeredCount;
        emit DeviceUnregistered(device, msg.sender);
    }

    function _register(address device, string calldata label) private {
        if (device == address(0)) revert InvalidParams();
        if (isRegistered[device]) revert AlreadyRegistered(device);
        isRegistered[device] = true;
        ++registeredCount;
        emit DeviceRegistered(device, label, msg.sender);
    }

    // ───────────────────────── 채굴 ─────────────────────────

    /// @notice share 제출. 유효하면 보상 한도 안에서 즉시 지급한다.
    ///         한도·풀 잔액 때문에 지급하지 못해도 share 자체는 승인해 처리량 기록을 남긴다(RewardWithheld 이벤트).
    /// @param nonce          찾은 nonce
    /// @param challengeUsed  채굴에 사용한 challenge — 에폭이 바뀐 뒤 늦게 도착한 제출을 명확한 오류로 거부하기 위함
    function submitShare(uint256 nonce, bytes32 challengeUsed)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 reward)
    {
        address miner = msg.sender;
        if (!isRegistered[miner]) revert NotRegistered(miner);
        if (challengeUsed != challenge) revert StaleChallenge(challenge, challengeUsed);

        uint256 last = lastShareAt[miner];
        if (last != 0 && block.timestamp < last + params.minShareInterval) {
            revert TooSoon(last + params.minShareInterval);
        }

        bytes32 digest = hashShare(challengeUsed, miner, nonce);
        if (uint256(digest) > miningTarget) revert DigestAboveTarget(digest, miningTarget);
        if (usedDigest[digest]) revert DuplicateShare(digest);

        usedDigest[digest] = true;
        lastShareAt[miner] = block.timestamp;
        ++acceptedShares[miner];
        ++totalAcceptedShares;
        ++epochShares;

        reward = _settleReward(miner);
        emit ShareAccepted(miner, nonce, digest, reward);

        if (epochShares >= params.sharesPerEpoch || block.timestamp >= epochExpiresAt()) {
            _adjustAndStartEpoch();
        }
    }

    /// @notice 제출이 끊겨 에폭이 만료됐을 때 누구나 호출해 난이도를 낮추고 새 에폭을 연다.
    function advanceEpoch() external whenNotPaused {
        uint256 expiresAt = epochExpiresAt();
        if (block.timestamp < expiresAt) revert EpochNotExpired(expiresAt);
        _adjustAndStartEpoch();
    }

    function setRewardMode(RewardMode mode) external {
        if (mode == RewardMode.Stake && !stakingEnabled) revert StakingUnavailable();
        rewardMode[msg.sender] = mode;
        emit RewardModeUpdated(msg.sender, mode);
    }

    // ───────────────────────── 조회 ─────────────────────────

    function hashShare(bytes32 challenge_, address miner, uint256 nonce) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(challenge_, miner, nonce));
    }

    /// @notice 목표 간격 기준 share 하나를 찾는 데 필요한 평균 해시 수
    function difficulty() external view returns (uint256) {
        return type(uint256).max / miningTarget;
    }

    /// @notice 이 시각 이후에는 제출이 없어도 에폭을 넘길 수 있다(목표 소요시간의 2배).
    function epochExpiresAt() public view returns (uint256) {
        return epochStartedAt + 2 * uint256(params.sharesPerEpoch) * params.targetInterval;
    }

    /// @notice 지금 share 하나를 제출하면 받게 될 보상. 0이면 reason에 사유가 들어 있다.
    function previewReward(address miner) external view returns (uint256 amount, bool limited, WithheldReason reason) {
        (amount, limited, reason, ) = _quote(miner);
    }

    function nextShareAllowedAt(address miner) external view returns (uint256) {
        uint256 last = lastShareAt[miner];
        return last == 0 ? 0 : last + params.minShareInterval;
    }

    function currentDay() public view returns (uint256) {
        return block.timestamp / 1 days;
    }

    // ───────────────────────── 관리 ─────────────────────────

    function setParams(Params calldata newParams) external onlyRole(PARAMS_ROLE) {
        _setParams(newParams);
    }

    function setTargetBounds(uint256 minTarget_, uint256 maxTarget_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setTargetBounds(minTarget_, maxTarget_);
        miningTarget = Math.min(Math.max(miningTarget, minTarget_), maxTarget_);
    }

    /// @notice 시험 초기에 측정값을 바탕으로 난이도를 직접 맞출 때 사용. 다음 에폭부터 자동 조절이 이어진다.
    function setTarget(uint256 newTarget) external onlyRole(PARAMS_ROLE) {
        if (newTarget < minTarget || newTarget > maxTarget) revert InvalidTarget();
        emit DifficultyAdjusted(epoch, miningTarget, newTarget, block.timestamp - epochStartedAt, epochShares);
        miningTarget = newTarget;
    }

    /// @notice 스테이킹 컨트랙트를 교체한다(자동 예치를 끈 상태에서만). 채굴 컨트랙트를 다시 배포하지 않고 연결하기 위함.
    function setStakingContract(address stakingContract) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stakingEnabled) revert StakingUnavailable();
        staking = IMSTStaking(stakingContract);
        emit StakingContractUpdated(stakingContract);
    }

    function setStakingEnabled(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (enabled && address(staking) == address(0)) revert StakingUnavailable();
        stakingEnabled = enabled;
        emit StakingEnabledUpdated(enabled);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ───────────────────────── 내부 ─────────────────────────

    function _quote(address miner)
        private
        view
        returns (uint256 amount, bool limited, WithheldReason reason, uint256 withheld)
    {
        Params memory p = params;
        amount = p.rewardPerShare;

        uint256 dailyLeft = p.dailyCapPerWallet - Math.min(paidOnDay[miner][currentDay()], p.dailyCapPerWallet);
        if (amount > dailyLeft) {
            (limited, reason, amount) = (true, WithheldReason.DailyCap, dailyLeft);
        }
        uint256 epochLeft = p.epochCap - Math.min(epochPaid, p.epochCap);
        if (amount > epochLeft) {
            (limited, reason, amount) = (true, WithheldReason.EpochCap, epochLeft);
        }
        // 풀 잔액이 모자라면 일부만 주지 않고 지급을 멈춘다.
        if (amount > 0 && address(this).balance < amount) {
            (limited, reason, amount) = (true, WithheldReason.PoolDepleted, 0);
        }
        withheld = p.rewardPerShare - amount;
    }

    function _settleReward(address miner) private returns (uint256 amount) {
        bool limited;
        WithheldReason reason;
        uint256 withheld;
        (amount, limited, reason, withheld) = _quote(miner);
        if (limited) emit RewardWithheld(miner, reason, withheld);
        if (amount == 0) return 0;

        paidOnDay[miner][currentDay()] += amount;
        epochPaid += amount;
        totalRewarded += amount;

        // 자동 예치를 골랐어도 스테이킹이 꺼져 있으면 지갑으로 보낸다.
        if (rewardMode[miner] == RewardMode.Stake && stakingEnabled) {
            // 스테이킹 컨트랙트가 거부(일시정지 등)해도 share 제출이 막히지 않도록 지갑으로 대신 보낸다.
            try staking.stakeFor{value: amount}(miner) {
                rewardedToStaking[miner] += amount;
                return amount;
            } catch {
                emit StakeFallbackToWallet(miner, amount);
            }
        }
        rewardedToWallet[miner] += amount;
        (bool ok, ) = payable(miner).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    function _adjustAndStartEpoch() private {
        uint256 oldTarget = miningTarget;
        uint256 elapsed = Math.max(block.timestamp - epochStartedAt, 1);
        uint256 shares = epochShares;

        uint256 newTarget;
        if (shares == 0) {
            newTarget = oldTarget * MAX_ADJUST_FACTOR;
        } else {
            uint256 expected = shares * params.targetInterval;
            uint256 cappedElapsed = Math.min(elapsed, expected * MAX_ADJUST_FACTOR);
            newTarget = Math.mulDiv(oldTarget, cappedElapsed, expected);
            newTarget = Math.max(newTarget, oldTarget / MAX_ADJUST_FACTOR);
        }
        newTarget = Math.min(Math.max(newTarget, minTarget), maxTarget);

        miningTarget = newTarget;
        emit DifficultyAdjusted(epoch, oldTarget, newTarget, elapsed, shares);
        ++epoch;
        _startEpoch();
    }

    function _startEpoch() private {
        challenge = keccak256(abi.encodePacked(blockhash(block.number - 1), epoch, address(this)));
        epochStartedAt = block.timestamp;
        epochShares = 0;
        epochPaid = 0;
        emit EpochStarted(epoch, challenge, miningTarget);
    }

    function _setParams(Params memory p) private {
        if (p.targetInterval == 0 || p.sharesPerEpoch == 0) revert InvalidParams();
        params = p;
        emit ParamsUpdated(p);
    }

    function _setTargetBounds(uint256 minTarget_, uint256 maxTarget_) private {
        // maxTarget * MAX_ADJUST_FACTOR 가 넘치지 않아야 한다.
        if (minTarget_ == 0 || minTarget_ > maxTarget_ || maxTarget_ > type(uint256).max / MAX_ADJUST_FACTOR) {
            revert InvalidTarget();
        }
        minTarget = minTarget_;
        maxTarget = maxTarget_;
        emit TargetBoundsUpdated(minTarget_, maxTarget_);
    }
}
