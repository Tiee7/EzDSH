const requiredNodeMajor = 22
const requiredNodeMinor = 19
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)

const supported = nodeMajor >= 24
  || (nodeMajor === requiredNodeMajor && nodeMinor >= requiredNodeMinor)

if (!supported) {
  console.error(`EzDSH requires Node.js ^${requiredNodeMajor}.${requiredNodeMinor}.0 or >=24.0.0; current version is ${process.versions.node}.`)
  console.error('Please switch Node.js with n, for example: n 24.18.0')
  process.exitCode = 1
}
