export const scenarios = [
  { entry: 'sdk', strategy: 'whole', targetBytes: 0, repetitions: 3 },
  { entry: 'sdk', strategy: 'scoped', targetBytes: 0, repetitions: 3 },
  { entry: 'sdk', strategy: 'chunks', targetBytes: 67108864, repetitions: 3 },
  { entry: 'sdk', strategy: 'chunks', targetBytes: 16777216, repetitions: 3 },
  { entry: 'app', strategy: 'scoped', targetBytes: 0, repetitions: 3 },
  { entry: 'app', strategy: 'chunks', targetBytes: 67108864, repetitions: 1 },
  { entry: 'api', strategy: 'scoped', targetBytes: 0, repetitions: 3 },
  { entry: 'api', strategy: 'chunks', targetBytes: 67108864, repetitions: 1 },
]
