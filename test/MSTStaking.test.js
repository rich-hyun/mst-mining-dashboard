const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const MST = (n) => ethers.parseEther(String(n));
const MAX_TARGET = ethers.MaxUint256 / 4n;
const EASY_TARGET = MAX_TARGET / 16n;
const near = (a, b, tol = 10n ** 6n) => expect(a >= b - tol && a <= b + tol, `${a} !~ ${b}`).to.equal(true);

async function deploy({ rate = MST(1) / 100n, reserve = MST(1000) } = {}) {
  const [admin, alice, bob, carol] = await ethers.getSigners();
  const staking = await (await ethers.getContractFactory("MSTStaking")).deploy(admin.address, rate);
  if (reserve > 0n) await staking.fundRewards({ value: reserve });
  return { staking, admin, alice, bob, carol };
}

describe("MSTStaking (자동 복리)", () => {
  it("예치 후 시간이 지나면 잔액이 재예치 없이 늘어난다", async () => {
    const { staking, alice } = await deploy(); // 0.01 MST/s
    await staking.connect(alice).stake({ value: MST(100) });
    await time.increase(1000);
    near(await staking.balanceOf(alice.address), MST(110), MST(1) / 10n);
    near(await staking.compoundedOf(alice.address), MST(10), MST(1) / 10n);
  });

  it("복리: 보상이 합쳐진 뒤 들어온 사람은 늘어난 총액 기준으로 지분을 받는다", async () => {
    const { staking, alice, bob } = await deploy();
    await staking.connect(alice).stake({ value: MST(100) });
    await time.increase(1000); // alice ≈ 110
    await staking.connect(bob).stake({ value: MST(110) });
    near(await staking.balanceOf(bob.address), MST(110), MST(1) / 10n);
    await time.increase(1000); // 총액 220에 +10 → 두 사람 각각 거의 +5
    near(await staking.balanceOf(alice.address), MST(115), MST(1) / 5n);
    near(await staking.balanceOf(bob.address), MST(115), MST(1) / 5n);
  });

  it("출금하면 보상 포함 금액을 돌려주고 컨트랙트 잔액 불변식이 유지된다", async () => {
    const { staking, alice } = await deploy();
    await staking.connect(alice).stake({ value: MST(100) });
    await time.increase(500);
    const before = await ethers.provider.getBalance(alice.address);
    const r = await (await staking.connect(alice).unstakeAll()).wait();
    const got = (await ethers.provider.getBalance(alice.address)) - before + r.gasUsed * r.gasPrice;
    near(got, MST(105), MST(1) / 10n);
    expect(await staking.sharesOf(alice.address)).to.equal(0n);
    expect(await ethers.provider.getBalance(await staking.getAddress())).to.equal(
      (await staking.totalAssets()) + (await staking.rewardReserve())
    );
  });

  it("일부 출금", async () => {
    const { staking, alice } = await deploy({ rate: 0n });
    await staking.connect(alice).stake({ value: MST(10) });
    await expect(staking.connect(alice).unstake(MST(4))).to.changeEtherBalance(alice, MST(4));
    near(await staking.balanceOf(alice.address), MST(6));
    await expect(staking.connect(alice).unstake(MST(7))).to.be.revertedWithCustomError(staking, "InsufficientShares");
  });

  it("준비금이 바닥나면 보상이 멈추고 원금은 유지된다", async () => {
    const { staking, alice } = await deploy({ reserve: MST(5) });
    await staking.connect(alice).stake({ value: MST(100) });
    await time.increase(100000);
    near(await staking.balanceOf(alice.address), MST(105), MST(1) / 100n);
    await staking.connect(alice).unstakeAll();
    expect(await staking.rewardReserve()).to.equal(0n);
  });

  it("예치자가 없는 동안에는 보상이 풀리지 않는다", async () => {
    const { staking, alice } = await deploy();
    await time.increase(10000);
    await staking.connect(alice).stake({ value: MST(1) });
    expect(await staking.rewardReserve()).to.equal(MST(1000));
    expect(await staking.totalEmitted()).to.equal(0n);
  });

  it("첫 예치자 지분 가격 조작(inflation attack)이 통하지 않는다", async () => {
    const { staking, alice, bob } = await deploy({ rate: 0n, reserve: 0n });
    await staking.connect(alice).stake({ value: 1n });
    // 직접 송금은 준비금으로만 들어가 지분 가격을 올리지 못한다.
    await alice.sendTransaction({ to: await staking.getAddress(), value: MST(10) });
    await staking.connect(bob).stake({ value: MST(5) });
    near(await staking.balanceOf(bob.address), MST(5), 10n ** 4n);
  });

  it("운영: 속도 변경·준비금 회수는 관리자만, 일시정지는 예치만 막고 출금은 허용", async () => {
    const { staking, alice, admin } = await deploy();
    await expect(staking.connect(alice).setRewardRate(1)).to.be.revertedWithCustomError(
      staking,
      "AccessControlUnauthorizedAccount"
    );
    await expect(staking.connect(alice).withdrawRewards(alice.address, 1)).to.be.revertedWithCustomError(
      staking,
      "AccessControlUnauthorizedAccount"
    );
    await expect(staking.withdrawRewards(admin.address, MST(2000))).to.be.revertedWithCustomError(
      staking,
      "ExceedsReserve"
    );
    await expect(staking.withdrawRewards(admin.address, MST(10))).to.changeEtherBalance(admin, MST(10));

    await staking.connect(alice).stake({ value: MST(1) });
    await staking.pause();
    await expect(staking.connect(alice).stake({ value: MST(1) })).to.be.revertedWithCustomError(staking, "EnforcedPause");
    await expect(staking.connect(alice).unstakeAll()).to.not.be.reverted;
  });

  it("0 입력 거부", async () => {
    const { staking, alice } = await deploy();
    await expect(staking.connect(alice).stake({ value: 0 })).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(staking.connect(alice).unstake(0)).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(staking.connect(alice).unstakeAll()).to.be.revertedWithCustomError(staking, "ZeroAmount");
  });
});

describe("채굴 보상 → 자동 복리 스테이킹 통합", () => {
  async function setup() {
    const [admin, alice] = await ethers.getSigners();
    const staking = await (await ethers.getContractFactory("MSTStaking")).deploy(admin.address, MST(1) / 100n);
    await staking.fundRewards({ value: MST(100) });
    const mining = await (await ethers.getContractFactory("MSTMiningReward")).deploy(
      admin.address,
      ethers.ZeroAddress,
      { rewardPerShare: MST(1), dailyCapPerWallet: MST(50), epochCap: MST(100), targetInterval: 60, sharesPerEpoch: 100, minShareInterval: 0 },
      EASY_TARGET,
      1n,
      MAX_TARGET
    );
    await mining.fundPool({ value: MST(50) });
    await mining.registerDevice(alice.address, "laptop");
    return { staking, mining, admin, alice };
  }

  async function mineOnce(mining, miner) {
    const challenge = await mining.challenge();
    const target = await mining.miningTarget();
    for (let n = 0n; ; n++) {
      const d = ethers.solidityPackedKeccak256(["bytes32", "address", "uint256"], [challenge, miner.address, n]);
      if (BigInt(d) <= target) return mining.connect(miner).submitShare(n, challenge);
    }
  }

  it("setStakingContract로 연결하면 채굴 보상이 채굴자 명의로 들어가 복리로 불어난다", async () => {
    const { staking, mining, alice } = await setup();
    await mining.setStakingContract(await staking.getAddress());
    await mining.setStakingEnabled(true);
    await mining.connect(alice).setRewardMode(1);

    await mineOnce(mining, alice);
    expect(await staking.balanceOf(alice.address)).to.be.gte(MST(1) - 10n ** 6n);
    expect(await mining.rewardedToStaking(alice.address)).to.equal(MST(1));
    await time.increase(200);
    expect(await staking.compoundedOf(alice.address)).to.be.gt(0n);

    // 켜 둔 상태에서는 스테이킹 컨트랙트를 바꿀 수 없다.
    await expect(mining.setStakingContract(ethers.ZeroAddress)).to.be.revertedWithCustomError(mining, "StakingUnavailable");
  });

  it("스테이킹이 일시정지여도 share 제출은 막히지 않고 지갑으로 지급된다", async () => {
    const { staking, mining, alice } = await setup();
    await mining.setStakingContract(await staking.getAddress());
    await mining.setStakingEnabled(true);
    await mining.connect(alice).setRewardMode(1);
    await staking.pause();

    const tx = await mineOnce(mining, alice);
    await expect(tx).to.emit(mining, "StakeFallbackToWallet").withArgs(alice.address, MST(1));
    expect(await mining.rewardedToWallet(alice.address)).to.equal(MST(1));
    expect(await mining.rewardedToStaking(alice.address)).to.equal(0n);
  });
});
