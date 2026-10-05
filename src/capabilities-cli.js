// Prints the Huly capability report: HULY_TOKEN=<token> npm run capabilities
const huly = require('./huly')

huly
  .getClient(process.env.HULY_TOKEN)
  .then((client) => huly.capabilities(client))
  .then((report) => {
    console.log(JSON.stringify(report, null, 2))
    process.exit(0)
  })
  .catch((err) => {
    console.error('Capability check failed:', err.message)
    process.exit(1)
  })
