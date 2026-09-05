module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testRegex: 'src/(.*/)?__tests__/.*\\.spec\\.ts$',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/__tests__/**'],
  coverageReporters: ['lcov', 'text-summary'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }]
  }
};
