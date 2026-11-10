// 컴파일된 ABI를 정적 웹 페이지가 import할 수 있는 web/js/abi.js로 내보낸다.
// 사용: npx hardhat compile && node scripts/export-abi.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const load = (name) => require(path.join(root, "artifacts", "contracts", `${name}.sol`, `${name}.json`));
const artifact = load("MSTMiningReward");
const stakingArtifact = load("MSTStaking");
const out = path.join(root, "web", "js", "abi.js");
fs.writeFileSync(
  out,
  "// 자동 생성 — scripts/export-abi.js. 컨트랙트를 고친 뒤 다시 생성할 것.\n" +
    `export const MINING_ABI = ${JSON.stringify(artifact.abi)};\n` +
    `export const STAKING_ABI = ${JSON.stringify(stakingArtifact.abi)};\n`
);
console.log(`wrote ${path.relative(root, out)} (${artifact.abi.length} entries)`);
