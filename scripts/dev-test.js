// The whole thing for testing, in one process: the site and the test bot, both on .env.test and
// both on the same throwaway database (LOCAL_DB_DIR). Nothing here touches the live league.
//   npm run dev:test
process.argv[2] = '.env.test';
await import('../server.js');
await import('../bot/index.js');
