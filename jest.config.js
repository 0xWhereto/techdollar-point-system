module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup.env.js'],
  testTimeout: 15000,
  verbose: true,
  modulePathIgnorePatterns: ['<rootDir>/node_modules/']
};
