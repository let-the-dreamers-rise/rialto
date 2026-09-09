// Local dev chain only; contracts are compiled by scripts/compile.mjs (solc-js).
module.exports = {
  solidity: '0.8.28',
  networks: {
    hardhat: {
      chainId: 5042002, // mirror Arc so chain-bound EIP-712 domains match
      accounts: { count: 10, accountsBalance: '100000000000000000000000' },
    },
  },
}
