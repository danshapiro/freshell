type QueuedTransition = () => void

let transitionInFlight = false
const transitionQueue: QueuedTransition[] = []

function startNextTransition(): void {
  if (transitionInFlight) return
  const next = transitionQueue.shift()
  if (!next) return
  transitionInFlight = true
  next()
}

/** Serialize managed visibility changes while starting the first one immediately. */
export function withManagedVisibilityTransition<T>(operation: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    transitionQueue.push(() => {
      let result: Promise<T>
      try {
        result = Promise.resolve(operation())
      } catch (error) {
        reject(error)
        transitionInFlight = false
        startNextTransition()
        return
      }

      result.then(
        (value) => {
          resolve(value)
          transitionInFlight = false
          startNextTransition()
        },
        (error) => {
          reject(error)
          transitionInFlight = false
          startNextTransition()
        },
      )
    })
    startNextTransition()
  })
}
