const { server } = require("./app");
const { PORT } = require("./config/index.js");
const db = require("./src/databases/index.js");

server.listen(PORT, async () => {
  await db.connect();
  console.log(`Server is running on port ${PORT}`);
});

process.on("SIGINT", async () => {
  await db.disconnect();
  process.exit(0);
});
