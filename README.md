# MST 채굴 시험 (mining-dashboard)

머스트셈(Mustsem, 체인 ID 7601) 네트워크의 **MST 채굴 처리량 시험**용 저장소입니다.
참여 장치가 브라우저에서 keccak256 작업증명(share)을 계산해 제출하면, 운영 지갑이 미리 넣어 둔 보상 풀에서 고정 규칙에 따라 MST를 지급합니다.
이번 단계의 목적은 수익이 아니라 **노트북·서버의 해시레이트를 측정하고, 참여자에게 배분할 수량을 계획할 근거 데이터를 만드는 것**입니다.

## 지키는 원칙

| 원칙 | 구현 |
|---|---|
| 시장가격 페그·가격방어 없음, 고정 규칙 지급 | `rewardPerShare` 고정값 × 승인 share. 가격을 참조하는 코드 없음 |
| 등록된 장치(지갑)만 보상 | `REGISTRAR_ROLE`이 등록한 주소만 `submitShare` 가능. digest에 채굴자 주소가 들어가 nonce를 가로채 쓸 수 없음 |
| 새로 발행하지 않음 | 컨트랙트에 mint 없음. `fundPool()`로 넣은 잔액 안에서만 지급, 부족하면 지급 중단 + `RewardWithheld(PoolDepleted)` |
| 시세·거래·교환·수익률·가치 보장 표현 없음 | 화면 문구는 "보상", "지급", "가치 비보장"만 사용 |
| 사용자가 누를 때만 채굴 | 시작 버튼 → 동의 화면(최초 1회) → Worker 생성. 정지·탭 종료(`pagehide`) 시 `terminate()`. 탭이 가려지면 기본 일시정지 |

## 구성

```
contracts/
  MSTMiningReward.sol        보상 컨트랙트 (Solidity 0.8.24, OpenZeppelin 5.0.2, evm london)
  MSTStaking.sol             자동 복리 스테이킹 (지분 방식, 보상 준비금에서 고정 속도로 합산)
  interfaces/IMSTStaking.sol 자동 예치용 스테이킹 인터페이스 (stakeFor)
  mocks/MockStaking.sol      테스트용 목업
test/                        Hardhat 테스트 (컨트랙트 24건 + 해시 일치 2건)
scripts/deploy.js            배포 → deployments/<network>.json, web/js/deployment.js 기록
scripts/export-abi.js        ABI → web/js/abi.js
web/                         정적 대시보드 (GitHub Pages 배포 가능, 빌드 불필요)
  js/keccak.js               keccak256 채굴 루프 (tools/gen-keccak.js가 생성, bench.js와 공용)
  js/miner-worker.js         Web Worker
tools/bench.js               CPU 해시레이트 벤치마크 → results/bench.csv
tools/estimate.js            배분 추정표 → results/allocation-estimate.{csv,md}
results/                     측정 결과
.github/workflows/pages.yml  web/ → GitHub Pages
```

## 컨트랙트 동작

- **challenge** = `keccak256(직전 블록 해시, 에폭 번호, 컨트랙트 주소)`, 에폭마다 바뀜
- **digest** = `keccak256(challenge ‖ 채굴자 주소 ‖ nonce)` (`abi.encodePacked`, 84바이트), `digest ≤ miningTarget`이면 유효
- **난이도 조절**: `sharesPerEpoch`건이 모이거나 에폭이 만료(`2 × sharesPerEpoch × targetInterval`초)되면
  `새 target = 이전 target × 실제 소요시간 / (share 수 × targetInterval)` (에폭 단위 이동평균, 1회 최대 4배, `[minTarget, maxTarget]` 범위).
  제출이 끊기면 누구나 `advanceEpoch()`를 호출해 난이도를 낮출 수 있습니다.
- **보상 한도**: 1건당 `rewardPerShare` → 지갑별 하루(UTC) `dailyCapPerWallet` → 에폭별 `epochCap` → 풀 잔액 순으로 깎습니다.
  한도에 걸려도 **share는 승인**하고(처리량 기록 유지) 보상만 0 또는 일부 지급하며 `RewardWithheld(miner, reason, amount)`를 남깁니다.
- **중복·남용 방지**: 같은 digest 재사용 금지(`DuplicateShare`), 지갑별 최소 제출 간격(`minShareInterval`), 지난 challenge 거부(`StaleChallenge`).
- **자동 복리 스테이킹** (`MSTStaking`): 채굴자가 `setRewardMode(Stake)`를 고르면 share 보상이 `stakeFor(채굴자)`로 채굴자 명의에 바로 예치됩니다.
  스테이킹은 ERC-4626과 같은 지분 방식이라, 운영 지갑이 `fundRewards`로 넣은 **보상 준비금**에서 초당 `rewardRate`만큼 예치 총액에 자동 합산됩니다(재예치 트랜잭션 불필요 = 복리).
  새로 발행하지 않으며 준비금이 바닥나면 보상만 멈추고 원금은 그대로입니다. 예치자가 없을 때는 보상이 풀리지 않고, 출금은 일시정지 중에도 가능합니다.
  스테이킹 컨트랙트가 예치를 거부하면(일시정지 등) share 제출이 막히지 않도록 그 보상은 지갑으로 대신 지급되고 `StakeFallbackToWallet`이 남습니다.
  채굴 컨트랙트는 `setStakingContract(addr)`로 스테이킹을 교체/연결할 수 있어(자동 예치를 끈 상태에서만) 재배포가 필요 없습니다. 화면에는 "스테이킹" 탭(예치·출금·합쳐진 보상 누계)이 있습니다.
  배포: `npx hardhat run scripts/deploy-staking.js --network mustsem` (`STAKING_REWARD_PER_DAY`, `STAKING_INITIAL_RESERVE`, `MINING_ADDRESS`), 이후 관리자 화면에서 자동 예치를 켭니다.
- **(참고) 기존 Mustsem 스테이킹**: 채굴자가 `setRewardMode(Wallet|Stake)`로 고릅니다. 스테이킹 주소는 생성자 인자입니다.
  현재 Mustsem 스테이킹(`0x8Fb0…7D07`)은 `stake(uint256)`로 **호출자 본인 명의의 wMST만** 받기 때문에, 채굴 컨트랙트가 대신 넣으면 채굴자가 아니라 컨트랙트 명의가 됩니다.
  그래서 이번 단계에서는 **즉시 지급만 사용**하고(`stakingEnabled = false`), `IMSTStaking.stakeFor(address)`를 구현한 스테이킹 컨트랙트가 배포되면 `setStakingEnabled(true)`로 켭니다. 동작은 목업으로 테스트되어 있습니다.
- **역할**: `DEFAULT_ADMIN_ROLE`(풀 회수, 일시정지, 난이도 범위, 스테이킹 on/off, 역할 관리), `REGISTRAR_ROLE`(장치 등록·해제), `PARAMS_ROLE`(보상·상한·난이도 값).

이벤트: `DeviceRegistered`, `DeviceUnregistered`, `RegistrationRequested`, `ShareAccepted(miner, nonce, hash, reward)`, `RewardWithheld`, `DifficultyAdjusted`, `EpochStarted`, `PoolFunded`, `PoolWithdrawn`, `ParamsUpdated`.

## 빠른 시작

```bash
npm install
npm test                 # 컨트랙트 + 해시 구현 테스트
npm run compile          # 컴파일 + web/js/abi.js 갱신
npm run serve            # http://127.0.0.1:8080 에서 대시보드 확인
```

로컬 체인으로 화면을 시험하려면:

```bash
npx hardhat node                                                        # 터미널 1
INITIAL_NETWORK_HPS=10000 INITIAL_FUND=100 \
  npx hardhat run scripts/deploy.js --network localhost                 # 터미널 2
# 브라우저: http://127.0.0.1:8080/?rpc=http://127.0.0.1:8545&chainId=31337&contract=<주소>&from=0
```

`rpc`, `chainId`, `contract`, `from` 쿼리 재지정은 **localhost에서만** 적용됩니다. 공개 페이지에서는 링크로 다른 RPC나 컨트랙트를 끼워 넣을 수 없습니다.

## 배포 순서 (Mustsem 메인넷)

1. **파라미터 결정**: `node tools/bench.js`로 사내 장비를 측정하고 `node tools/estimate.js`로 하루 지급량을 확인합니다(아래 "측정" 절).
2. **환경변수 설정** (`.env`는 커밋하지 않습니다):
   ```bash
   export DEPLOYER_PRIVATE_KEY=0x...        # 배포 지갑 (가스용 MST 소량)
   export ADMIN_ADDRESS=0x...               # 운영 관리자 (멀티시그 권장)
   export INITIAL_NETWORK_HPS=5000000       # 예상 전체 해시레이트 → 초기 난이도
   ```
3. **배포**: `npm run deploy:mustsem` → `deployments/mustsem.json`, `web/js/deployment.js`가 갱신됩니다.
4. **풀 충전**: 관리자 화면의 "보상 풀 → 충전" 또는 컨트랙트 주소로 MST를 송금합니다(둘 다 `PoolFunded` 기록).
   운영 지갑에서 처음부터 많은 양을 넣기보다 1~2주치씩 나눠 넣는 것을 권장합니다.
5. **장치 등록**: 관리자 화면에서 사내 장비 주소를 등록합니다. 승인된 외부 참여자는 대시보드에서 "참여 신청"을 하면 관리자 화면의 신청 목록에 나타나고, "승인"을 누르면 등록됩니다.
6. **대시보드 공개**: `web/` 변경을 main에 푸시하면 GitHub Actions(`pages.yml`)가 Pages로 배포합니다. 저장소 Settings → Pages → Source를 "GitHub Actions"로 설정해 두세요.
7. 블록 탐색기 주소가 정해지면 `web/js/config.js`의 `explorerUrl`을 채웁니다(기록 화면에 트랜잭션 링크가 생깁니다).

### 환경변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `MST_RPC_URL` | `https://block.mustree.kr` | Mustsem RPC |
| `DEPLOYER_PRIVATE_KEY` | – | 배포 지갑 개인키 |
| `ADMIN_ADDRESS` | 배포자 | 세 역할을 모두 받을 관리자 |
| `STAKING_ADDRESS` | `0x0` | `IMSTStaking` 구현 컨트랙트. 없으면 0 |
| `REWARD_PER_SHARE` | `1` | share 1건당 MST |
| `DAILY_CAP_PER_WALLET` | `50` | 지갑별 하루 상한 (MST) |
| `EPOCH_CAP` | `500` | 에폭별 총량 상한 (MST) |
| `TARGET_INTERVAL_SEC` | `60` | 네트워크 전체 목표 제출 간격 |
| `SHARES_PER_EPOCH` | `30` | 에폭 크기 = 난이도 조절 주기 (약 30분) |
| `MIN_SHARE_INTERVAL_SEC` | `60` | 지갑별 최소 제출 간격 |
| `INITIAL_NETWORK_HPS` | `1000000` | 초기 난이도 계산용 예상 해시레이트 |
| `MIN_TARGET` | `1` | 가장 어려운 난이도 한계 |
| `INITIAL_FUND` | `0` | 배포 직후 풀에 넣을 MST |

참고: 기본값(1 MST × 30 share)이면 에폭당 최대 지급이 30 MST라서 `EPOCH_CAP` 500은 실제로 걸리지 않습니다. 보상을 올릴 때의 안전장치로 남겨 둔 값입니다.

## 관리자 운영

관리자 탭은 세 역할 중 하나라도 가진 지갑이 체인 7601에 연결되어 있을 때만 보입니다.

| 작업 | 화면 | 컨트랙트 함수 | 필요 역할 |
|---|---|---|---|
| 장치 등록·해제, 일괄 등록 | 장치 등록·해제 | `registerDevice`, `registerDevices`, `unregisterDevice` | REGISTRAR |
| 참여 신청 승인 | 참여 신청 목록 → 승인 | `registerDevice` | REGISTRAR |
| 풀 충전 | 보상 풀 → 충전 | `fundPool` | 누구나 |
| 풀 회수 | 보상 풀 → 회수 (연결 지갑으로) | `withdrawPool` | ADMIN |
| 보상·상한·간격 변경 | 보상·상한 파라미터 | `setParams` | PARAMS |
| 난이도 직접 설정 | 예상 해시레이트 입력 → 목표값 적용 | `setTarget` | PARAMS |
| 스테이킹 자동 예치 on/off | 운영 | `setStakingEnabled` | ADMIN |
| 긴급 정지·재개 | 운영 | `pause`, `unpause` | ADMIN |

운영 팁:
- 측정 초기에 참여 장치 수가 크게 바뀌면 "난이도 직접 설정"으로 맞추고, 이후에는 자동 조절에 맡깁니다.
- 풀 잔액이 하루 지급 예상치의 3일분 아래로 내려가면 충전합니다(대시보드의 "보상 풀 잔액").
- 관리자 키는 하드웨어 지갑이나 멀티시그로 보관하고, `DEPLOYER_PRIVATE_KEY`는 배포 뒤 폐기하거나 잔액을 비웁니다.

## 웹 대시보드

- **채굴**: 스레드 수(Web Worker)와 CPU 사용률 상한(25/50/75/100%, 계산·휴식 비율로 조절)을 고르고 시작합니다. 처음 시작할 때 동의 화면(전력·발열, 가치 비보장, 정지 방식)에서 세 항목을 모두 체크해야 합니다.
  등록되지 않은 지갑이거나 지갑을 연결하지 않았으면 **측정 전용 모드**로 같은 계산을 하되 제출하지 않습니다.
- **제출 정책**: share를 찾으면 ① 화면 최소 간격(60초)과 컨트랙트 `minShareInterval` 중 긴 쪽이 지났는지 ② `previewReward`가 0이 아닌지(옵션) ③ `estimateGas`로 미리 검증하고 예상 가스비가 보상보다 작은지를 확인한 뒤 제출합니다. 각 제출은 지갑에서 서명해야 합니다.
- **대시보드**: 현재 해시레이트, 누적 해시 수(이 브라우저), 제출·승인 건수, 받은 MST, 스테이킹으로 보낸 MST, 오늘 받은 양/상한, 난이도, 예상 share 시간, 풀 잔액, 에폭 진행, 등록 장치 수.
- **기록**: 내 `ShareAccepted` 이벤트(블록, 시각, 해시, 보상), 최근 200건.
- 한국어/영어 전환, 모바일 레이아웃 지원.

## 측정 (해시레이트 → 배분 추정)

```bash
# 장치마다 실행. --sweep은 1,2,4…코어 수까지 스레드를 바꿔 가며 측정
node tools/bench.js --device "사무실 노트북-01" --seconds 20 --sweep --watts 28
node tools/bench.js --device gpu-srv-01 --gpu "RTX 4090" --threads 32 --watts 310
node tools/estimate.js --pool 10000 --hours 24
```

`bench.js`는 대시보드 Worker와 **같은 `web/js/keccak.js`**를 쓰므로 측정값이 브라우저 채굴 속도와 같은 코드에서 나옵니다(브라우저는 보통 Node보다 조금 느립니다). 소비전력은 전력계 값을 `--watts`로 직접 넣으면 `hashes_per_joule`이 계산됩니다.

**GPU**: 이번 단계에서는 GPU(WebGPU/OpenCL) 버전을 만들지 않았고 CPU 결과만 냅니다. GPU 서버도 CPU로 측정하고 `--gpu`에는 이름만 기록합니다.

### 현재 측정 결과 (`results/bench.csv`)

| 장치 | CPU | 스레드 | H/s |
|---|---|---:|---:|
| dev-laptop-01 | Intel i5-1135G7 (4코어 8스레드) | 1 | 333,669 |
| | | 2 | 568,233 |
| | | 4 | 940,264 |
| | | 8 | 1,049,282 |

같은 노트북에서 헤드리스 Chrome 2스레드 실측은 약 0.49~0.53 MH/s였습니다.
추정표는 `results/allocation-estimate.md`에 있습니다. 요점: 난이도가 조절된 뒤에는 네트워크 전체 share가 목표 간격(기본 하루 1,440건)으로 수렴하므로, **하루 총 지급량은 해시레이트가 아니라 `rewardPerShare × 86400/targetInterval`과 지갑별 상한으로 정해집니다**(기본값: 장치 20대까지는 일일 상한 50 MST × 장치 수, 그 이상은 1,440 MST/일).

## 위험 고지

대시보드의 "위험 고지" 탭과 같은 내용입니다.

- **기술 위험**: 브라우저 채굴은 CPU를 오래 사용해 전력 소모·발열·배터리 수명 저하가 생길 수 있습니다. 브라우저·기기에 따라 성능이 크게 다르며 측정값은 참고용입니다.
- **컨트랙트 위험**: 스마트컨트랙트는 테스트를 거쳤지만 외부 보안감사를 받지 않았습니다. 결함이 있을 수 있으며, 운영자는 파라미터 변경·일시정지·풀 회수 권한을 가집니다. 보상 풀이 비면 지급이 멈춥니다.
- **키 관리**: 이 페이지는 개인키를 다루지 않으며 모든 서명은 지갑에서 이루어집니다. 개인키·복구 문구를 누구에게도 알려 주지 마세요. 잃어버린 키는 되찾을 수 없습니다. 운영자 키는 하드웨어 지갑·멀티시그로 관리합니다.
- **가치 비보장**: MST는 Mustsem 네트워크 수수료에 쓰는 유틸리티 토큰입니다. 보상은 고정 규칙에 따라 지급되며 어떠한 가치도 보장하지 않습니다. 운영자는 가격을 유지하거나 방어하지 않습니다.
- **참여 조건**: 관리자가 승인해 등록한 지갑만 보상을 받습니다. 지갑별 하루 상한과 에폭별 총량 상한이 있으며 운영 중 조정될 수 있습니다.

## 남은 일

- `MSTStaking` 메인넷 배포 + 준비금 충전 + `setStakingContract`/`setStakingEnabled(true)` (이미 배포된 채굴 컨트랙트는 `staking`이 immutable이던 버전이므로 새 버전으로 재배포가 한 번 필요)
- 블록 탐색기 주소 확정 후 `explorerUrl` 설정
- GPU(WebGPU) 채굴·측정 버전
- VYD 체인 DataProvenanceRegistry에 측정 CSV 해시 등록 (이번 단계에서는 제외)
- 메인넷 배포 전 외부 보안감사 권장
