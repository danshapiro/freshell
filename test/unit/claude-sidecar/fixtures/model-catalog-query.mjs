export function query({ prompt }) {
  return {
    async supportedModels() {
      const input = await prompt.next()
      if (!input.done) throw new Error('A catalog probe must not send an agent prompt')
      return [{ value: 'sonnet', displayName: 'Claude Sonnet', supportedEffortLevels: ['low', 'high'] }]
    },
    close() {},
  }
}
