// MSTStaking(자동 복리 스테이킹) 배포 스크립트.
// 사용: npx hardhat run scripts/deploy-staking.js --network mustsem
// 환경변수:
//   ADMIN_ADDRESS          관리자 (기본: 배포자)
//   STAKING_REWARD_PER_DAY 하루에 준비금에서 풀리는 총 보상 MST (기본 100)
//   STAKING_INITIAL_RESERVE 배포 직후 보상 준비금에 넣을 MST (기본 0)
//   MINING_ADDRESS         이미 배포된 MSTMiningReward. 주어지고 배포자가 관리자이면 setStakingContract까지 호출
// 자동 예치 켜기(setStakingEnabled(true))는 준비금을 채운 뒤 관리자 화면에서 직접 한다.
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");

const env = (k, d) => (process.env[k] === undefined || process.env[k] === "" ? d : process.env[k]);

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("DEPLOYER_PRIVATE_KEY가 설정되지 않았습니다.");
  const admin = env("ADMIN_ADDRESS", deployer.address);
  const perDay = ethers.parseEther(env("STAKING_REWARD_PER_DAY", "100"));
  const rate = perDay / 86400n;
  const reserve = ethers.parseEther(env("STAKING_INITIAL_RESERVE", "0"));

  console.log(`network=${network.name} deployer=${deployer.address} admin=${admin} rate=${rate} wei/s (~${ethers.formatEther(rate * 86400n)} MST/일)`);
  const Staking = await ethers.getContractFactory("MSTStaking");
  const staking = await Staking.deploy(admin, rate);
  const receipt = await staking.deploymentTransaction().wait();
  const address = await staking.getAddress();
  console.log(`MSTStaking → ${address} (block ${receipt.blockNumber})`);

  if (reserve > 0n) {
    await (await staking.fundRewards({ value: reserve })).wait();
    console.log(`보상 준비금 ${ethers.formatEther(reserve)} MST 충전`);
  }

  const miningAddr = env("MINING_ADDRESS", "");
  if (miningAddr) {
    const mining = await ethers.getContractAt("MSTMiningReward", miningAddr);
    try {
      await (await mining.setStakingContract(address)).wait();
      console.log(`MSTMiningReward(${miningAddr}).setStakingContract 완료. 준비금을 채운 뒤 setStakingEnabled(true)를 호출하세요.`);
    } catch (e) {
      console.log(`setStakingContract 실패(관리자 지갑으로 직접 호출하세요): ${e.shortMessage || e.message}`);
    }
  }

  const root = path.join(__dirname, "..");
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "deployments", `${network.name}.staking.json`),
    JSON.stringify(
      { network: network.name, chainId: network.config.chainId, contract: "MSTStaking", address, deployBlock: receipt.blockNumber, deployTx: receipt.hash, admin, rewardRatePerSecond: rate.toString(), deployedAt: new Date().toISOString() },
      null,
      2
    ) + "\n"
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
