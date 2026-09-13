export function partitionSendKeysArgs(args: string[], targetFromFlag?: string): { target?: string; keyArgs: string[] } {
  if (targetFromFlag) {
    return { target: targetFromFlag, keyArgs: args }
  }
  if (!args.length) {
    return { target: undefined, keyArgs: [] }
  }
  const [target, ...keyArgs] = args
  return { target, keyArgs }
}
