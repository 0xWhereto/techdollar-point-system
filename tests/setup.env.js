// Runs once per test file BEFORE any module is loaded — pin tests to an
// in-memory sqlite so we never touch a real database.sqlite file.
process.env.NODE_ENV = 'test';
process.env.USE_LOCAL_DB = 'true';
process.env.SQLITE_PATH = ':memory:';
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'silent';
