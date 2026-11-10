// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IMSTStaking} from "./interfaces/IMSTStaking.sol";

/// @title  MSTStaking
/// @notice 네이티브 MST를 예치하면 지분(share)을 받고, 보상 준비금에서 고정 속도로 풀려나오는 MST가
///         예치 총액에 자동으로 합쳐지는(= 자동 복리) 스테이킹 컨트랙트. 새로 발행하지 않는다.
/// @dev    - 지분 방식(ERC-4626과 같은 계산)이라 재예치(compound) 트랜잭션이 필요 없다. 보상이 쌓일수록
///           지분 1개가 가리키는 MST가 늘어난다.
///         - 보상은 `rewardReserve`(운영 지갑이 `fundRewards`로 넣은 양) 안에서만, 초당 `rewardRate`만큼 풀린다.
///           준비금이 바닥나면 보상이 멈추고 원금은 그대로다. 시장가격을 참조하는 코드는 없다.
///         - 예치자가 없는 동안에는 보상이 풀리지 않는다(준비금에 그대로 남는다).
///         - 출금은 일시정지 중에도 항상 가능하다. 일시정지는 신규 예치만 막는다.
///         - 불변식: address(this).balance == totalAssets + rewardReserve
///         - `stakeFor`는 MSTMiningReward가 채굴 보상을 채굴자 명의로 넣을 때 쓴다.
contract MSTStaking is IMSTStaking, AccessControl, Pausable, ReentrancyGuard {
    /// @dev 첫 예치자에 대한 지분 가격 조작(inflation attack)을 막는 가상 지분.
    uint256 private constant VIRTUAL_SHARES = 1e3;

    uint256 public totalAssets; // 예치 원금 + 이미 합쳐진 보상
    uint256 public totalShares;
    uint256 public rewardReserve; // 아직 풀리지 않은 보상 준비금
    uint256 public rewardRate; // 초당 풀리는 보상 (wei/s)
    uint256 public lastAccrual;
    uint256 public totalEmitted; // 지금까지 예치 총액에 합쳐진 보상 누계

    mapping(address => uint256) public sharesOf;
    mapping(address => uint256) public netDeposited; // 예치 누계 - 출금 누계(원금 추정치, 복리분 표시용)

    event Staked(address indexed payer, address indexed beneficiary, uint256 amount, uint256 shares);
    event Unstaked(address indexed account, uint256 amount, uint256 shares);
    event RewardsFunded(address indexed from, uint256 amount, uint256 reserve);
    event RewardsWithdrawn(address indexed to, uint256 amount, uint256 reserve);
    event RewardRateUpdated(uint256 oldRate, uint256 newRate);
    event Accrued(uint256 amount, uint256 totalAssets);

    error ZeroAmount();
    error InsufficientShares();
    error ExceedsReserve();
    error TransferFailed();

    constructor(address admin, uint256 rewardRate_) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        rewardRate = rewardRate_;
        lastAccrual = block.timestamp;
    }

    // ───────────────────────── 예치 / 출금 ─────────────────────────

    function stake() external payable whenNotPaused nonReentrant {
        _stake(msg.sender, msg.sender);
    }

    /// @notice 보낸 MST를 beneficiary 명의로 예치한다(채굴 보상 자동 예치용).
    function stakeFor(address beneficiary) external payable override whenNotPaused nonReentrant {
        _stake(msg.sender, beneficiary);
    }

    /// @notice MST 수량으로 출금한다(보상 포함 잔액 이내). 필요한 지분은 올림해 컨트랙트에 불리하지 않게 한다.
    function unstake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _accrue();
        uint256 s = Math.mulDiv(amount, totalShares + VIRTUAL_SHARES, totalAssets + 1, Math.Rounding.Ceil);
        _withdraw(msg.sender, s, amount);
    }

    function unstakeAll() external nonReentrant {
        _accrue();
        uint256 s = sharesOf[msg.sender];
        if (s == 0) revert ZeroAmount();
        _withdraw(msg.sender, s, _toAssets(s));
    }

    // ───────────────────────── 조회 ─────────────────────────

    /// @notice 아직 totalAssets에 반영되지 않은, 지금까지 풀린 보상
    function pendingEmission() public view returns (uint256) {
        if (totalShares == 0 || rewardRate == 0) return 0;
        return Math.min((block.timestamp - lastAccrual) * rewardRate, rewardReserve);
    }

    /// @notice 보상 반영 후 계정의 MST 잔액
    function balanceOf(address account) public view returns (uint256) {
        return Math.mulDiv(sharesOf[account], totalAssets + pendingEmission() + 1, totalShares + VIRTUAL_SHARES);
    }

    /// @notice 잔액 중 원금(예치-출금 누계)을 넘는 부분 = 복리로 쌓인 보상
    function compoundedOf(address account) external view returns (uint256) {
        uint256 bal = balanceOf(account);
        uint256 principal = netDeposited[account];
        return bal > principal ? bal - principal : 0;
    }

    function totalAssetsNow() external view returns (uint256) {
        return totalAssets + pendingEmission();
    }

    // ───────────────────────── 보상 준비금 / 운영 ─────────────────────────

    receive() external payable {
        _fundRewards();
    }

    function fundRewards() external payable {
        _fundRewards();
    }

    function withdrawRewards(address payable to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        _accrue();
        if (amount > rewardReserve) revert ExceedsReserve();
        rewardReserve -= amount;
        _send(to, amount);
        emit RewardsWithdrawn(to, amount, rewardReserve);
    }

    function setRewardRate(uint256 newRate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _accrue();
        emit RewardRateUpdated(rewardRate, newRate);
        rewardRate = newRate;
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    // ───────────────────────── 내부 ─────────────────────────

    function _stake(address payer, address beneficiary) private {
        if (msg.value == 0) revert ZeroAmount();
        _accrue();
        uint256 s = Math.mulDiv(msg.value, totalShares + VIRTUAL_SHARES, totalAssets + 1);
        if (s == 0) revert ZeroAmount();
        totalAssets += msg.value;
        totalShares += s;
        sharesOf[beneficiary] += s;
        netDeposited[beneficiary] += msg.value;
        emit Staked(payer, beneficiary, msg.value, s);
    }

    function _withdraw(address account, uint256 s, uint256 amount) private {
        if (s > sharesOf[account]) revert InsufficientShares();
        if (amount > totalAssets) amount = totalAssets;
        sharesOf[account] -= s;
        totalShares -= s;
        totalAssets -= amount;
        uint256 principal = netDeposited[account];
        netDeposited[account] = (sharesOf[account] == 0 || amount >= principal) ? 0 : principal - amount;
        _send(payable(account), amount);
        emit Unstaked(account, amount, s);
    }

    function _accrue() private {
        uint256 dt = block.timestamp - lastAccrual;
        lastAccrual = block.timestamp;
        if (dt == 0 || totalShares == 0 || rewardRate == 0) return;
        uint256 e = Math.min(dt * rewardRate, rewardReserve);
        if (e == 0) return;
        rewardReserve -= e;
        totalAssets += e;
        totalEmitted += e;
        emit Accrued(e, totalAssets);
    }

    function _fundRewards() private {
        _accrue();
        rewardReserve += msg.value;
        emit RewardsFunded(msg.sender, msg.value, rewardReserve);
    }

    function _toAssets(uint256 s) private view returns (uint256) {
        return Math.mulDiv(s, totalAssets + 1, totalShares + VIRTUAL_SHARES);
    }

    function _send(address payable to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
