// https://juejin.cn/post/7189580059399684154?searchId=20231217141525C8B12B63855B0DC5B861#heading-2

import { ErrorCodes, callWithErrorHandling } from './errorHandling'
import { Awaited, isArray, NOOP } from '@vue/shared'
import { ComponentInternalInstance, getComponentName } from './component'
import { warn } from './warning'

export interface SchedulerJob extends Function {
  id?: number // 代表当前任务的优先级，值越小优先级越大
  pre?: boolean // 是否是前置任务
  active?: boolean // 当前任务是否可执行，为false表示在执行阶段，跳过这个任务
  computed?: boolean

  allowRecurse?: boolean // 是否允许递归

  ownerInstance?: ComponentInternalInstance
}

export type SchedulerJobs = SchedulerJob | SchedulerJob[]

// 是否正在执行任务
let isFlushing = false
// 是否有在等待的任务
let isFlushPending = false

// 普通队列，用于存放前置任务和普通任务
const queue: SchedulerJob[] = []

//  遍历普通队列时使用的指针
let flushIndex = 0

// 后置队列，用于存放后置任务
const pendingPostFlushCbs: SchedulerJob[] = []

// 保证直接使用flushPostFlushCbs时，任务的正确执行顺序
let activePostFlushCbs: SchedulerJob[] | null = null

// 遍历后置队列时使用的指针
let postFlushIndex = 0

// 创建一个微任务队列
const resolvedPromise = /*#__PURE__*/ Promise.resolve() as Promise<any>

// 现在是否有正在执行任务的微任务队列
let currentFlushPromise: Promise<void> | null = null

// 最大递归限制
const RECURSION_LIMIT = 100

// seen的类型，seen是一个Map,用于缓存job的执行次数,如果超过了RECURSION_LIMIT的执行次数,将会警报用户
type CountMap = Map<SchedulerJob, number>

export function nextTick<T = void, R = void>(
  this: T,
  fn?: (this: T) => R
): Promise<Awaited<R>> {
  // 如果此时正在执行微任务队列说明currentFlushPromise有值，那么将该fn放入微任务队列中
  // 如果此时没有正在执行微任务队列，那就赋值一个新的微任务队列，将fn放在该微任务队列中
  const p = currentFlushPromise || resolvedPromise
  return fn ? p.then(this ? fn.bind(this) : fn) : p
}

// 使用二分查找，根据任务的优先级找到合适的位置，将任务进行插入
// 使得队列保持任务id递增的顺序
// 防止任务被跳过，或者被重复执行
function findInsertionIndex(id: number) {
  // the start index should be `flushIndex + 1`
  let start = flushIndex + 1
  let end = queue.length

  while (start < end) {
    const middle = (start + end) >>> 1
    const middleJob = queue[middle]
    const middleJobId = getId(middleJob)
    // 如果该任务的优先级与middleJobId相同，但middleJob是前置任务，那么就要将其插入到middleJob之后的位置
    // 因为普通任务如果与前置任务优先级相同，那么前置任务先执行
    if (middleJobId < id || (middleJobId === id && middleJob.pre)) {
      start = middle + 1
    } else {
      end = middle
    }
  }

  return start
}

// 将前置任务和普通任务插入到普通队列(queue)中
export function queueJob(job: SchedulerJob) {
  // 重复数据搜索使用Array.includes()的startIndex参数
  // 默认情况下，搜索索引包括当前正在运行的作业
  // 这样它就不能再递归触发自己了。
  // 如果作业是watch()回调，则搜索将以+1索引开始
  // 允许它递归触发自己——这是用户的责任
  // 确保它不会陷入无限循环。

  // 如果普通队列长度为0 或者 此任务不再普通队列中，那么将其加入queue
  if (
    !queue.length ||
    !queue.includes(
      job,
      isFlushing && job.allowRecurse ? flushIndex + 1 : flushIndex
    )
  ) {
    if (job.id == null) {
      // 如果该任务没有优先级，则默认其优先级最低，放在队列最后面
      queue.push(job)
    } else {
      // 否则，找到合适的位置将其插入到queue中
      queue.splice(findInsertionIndex(job.id), 0, job)
    }
    // 执行任务
    queueFlush()
  }
}

// 将执行任务的函数放入微任务队列中，这样任务就能在微任务队列中执行了
function queueFlush() {
  // 如果当前没有正在执行的任务，并且没有正在等待的任务
  // 说明此时执行的任务将会被添加到微任务队列中
  // 那么将isFlushPending置为true，代表此时微任务对列中将有正在等待的任务
  if (!isFlushing && !isFlushPending) {
    isFlushPending = true
    currentFlushPromise = resolvedPromise.then(flushJobs)
  }
}

export function invalidateJob(job: SchedulerJob) {
  const i = queue.indexOf(job)
  if (i > flushIndex) {
    queue.splice(i, 1)
  }
}

// 将后置任务放在后置队列中
export function queuePostFlushCb(cb: SchedulerJobs) {
  if (!isArray(cb)) {
    if (
      !activePostFlushCbs ||
      !activePostFlushCbs.includes(
        cb,
        cb.allowRecurse ? postFlushIndex + 1 : postFlushIndex
      )
    ) {
      pendingPostFlushCbs.push(cb)
    }
  } else {
    // if cb is an array, it is a component lifecycle hook which can only be
    // triggered by a job, which is already deduped in the main queue, so
    // we can skip duplicate check here to improve perf
    pendingPostFlushCbs.push(...cb)
  }
  // 执行任务
  queueFlush()
}

// 执行前置任务队列
export function flushPreFlushCbs(
  instance?: ComponentInternalInstance,
  seen?: CountMap,
  // if currently flushing, skip the current job itself
  i = isFlushing ? flushIndex + 1 : 0
) {
  if (__DEV__) {
    seen = seen || new Map()
  }
  // 遍历普通队列，执行前置任务，每执行完一个前置任务就将该任务从队列中删除
  for (; i < queue.length; i++) {
    const cb = queue[i]
    if (cb && cb.pre) {
      if (instance && cb.id !== instance.uid) {
        continue
      }
      if (__DEV__ && checkRecursiveUpdates(seen!, cb)) {
        continue
      }
      queue.splice(i, 1)
      i--
      cb()
    }
  }
}

// 执行后置任务队列
// activePostFlushCbs作用：保证任务正确的执行顺序，因为通过直接调用flushPostFlushCbs执行任务
// 此时的任务执行不是异步的，如果没有activePostFlushCbs，第二次调用的flushPostFlushCbs会同步执行
// 也就是在第一次调用flushPostFlushCbs后，第一次的后置任务还没有执行完，此时第二次调用还是同步执行，因此会打乱执行顺序。
export function flushPostFlushCbs(seen?: CountMap) {
  if (pendingPostFlushCbs.length) {
    // 复制后置任务队列后将其清空
    const deduped = [...new Set(pendingPostFlushCbs)]
    pendingPostFlushCbs.length = 0

    // #1947 already has active queue, nested flushPostFlushCbs call
    // 已经有活动队列，嵌套flushPostFlushCbs调用
    // 为了不打乱任务调度执行的顺序，将新加入的后置任务，放到活动队列的最后
    if (activePostFlushCbs) {
      activePostFlushCbs.push(...deduped)
      return
    }

    activePostFlushCbs = deduped
    if (__DEV__) {
      seen = seen || new Map()
    }

    // 将任务按照优先级排序
    activePostFlushCbs.sort((a, b) => getId(a) - getId(b))

    for (
      postFlushIndex = 0;
      postFlushIndex < activePostFlushCbs.length;
      postFlushIndex++
    ) {
      if (
        __DEV__ &&
        checkRecursiveUpdates(seen!, activePostFlushCbs[postFlushIndex])
      ) {
        continue
      }
      activePostFlushCbs[postFlushIndex]()
    }
    // 后置任务执行完毕后，进行初始化操作
    activePostFlushCbs = null
    postFlushIndex = 0
  }
}

// job的id
const getId = (job: SchedulerJob): number =>
  job.id == null ? Infinity : job.id

// 使用sort进行排序时，传入的比较规则
// 优先数小的优先级高，优先级高的排在前面，优先级相同前置任务先执行
const comparator = (a: SchedulerJob, b: SchedulerJob): number => {
  const diff = getId(a) - getId(b)
  if (diff === 0) {
    if (a.pre && !b.pre) return -1
    if (b.pre && !a.pre) return 1
  }
  return diff
}

// 执行任务(包括前置，普通，后置)
function flushJobs(seen?: CountMap) {
  // 将微任务队列中的任务执行完，代表着微任务队列中没有正在等待的任务
  // 所以将isFlushPending置为false
  // 因为要执行任务了，所以将isFlushing置为true
  isFlushPending = false
  isFlushing = true
  if (__DEV__) {
    seen = seen || new Map()
  }

  // Sort queue before flush.
  // This ensures that:
  // 1. Components are updated from parent to child. (because parent is always
  //    created before the child so its render effect will have smaller
  //    priority number)
  // 2. If a component is unmounted during a parent component's update,
  //    its update can be skipped.

  // 1. 组件更新是从父组件到子组件(因为父组件总是在子组件之前被创建，所以父组件的render副作用函数将有更小的优先数，
  //    意味着父组件的render副作用函数优先级更高)

  // 2. 如果在父组件的更新过程中卸载了组件，则可以跳过其更新。
  queue.sort(comparator)

  //监测当前任务是否已经超过了最大递归层数
  const check = __DEV__
    ? (job: SchedulerJob) => checkRecursiveUpdates(seen!, job)
    : NOOP

  try {
    // 遍历普通任务队列，将前置和普通任务执行完毕
    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {
      const job = queue[flushIndex]
      if (job && job.active !== false) {
        if (__DEV__ && check(job)) {
          continue
        }
        // console.log(`running:`, job.id)
        callWithErrorHandling(job, null, ErrorCodes.SCHEDULER)
      }
    }
  } finally {
    // 前置任务和普通任务执行完毕后，进行初始化，然后执行后置任务
    flushIndex = 0
    queue.length = 0

    // 执行后置任务
    flushPostFlushCbs(seen)

    isFlushing = false
    currentFlushPromise = null

    // 如果在执行这些任务的过程中有新的任务加入，那么需要继续调用flushJobs将任务执行完
    if (queue.length || pendingPostFlushCbs.length) {
      flushJobs(seen)
    }
  }
}

// 检查任务递归深度是否超过最大限制
// seen是一个Map,用于缓存job的执行次数,如果超过了RECURSION_LIMIT的执行次数,将会警报用户
function checkRecursiveUpdates(seen: CountMap, fn: SchedulerJob) {
  if (!seen.has(fn)) {
    seen.set(fn, 1)
  } else {
    const count = seen.get(fn)!
    if (count > RECURSION_LIMIT) {
      const instance = fn.ownerInstance
      const componentName = instance && getComponentName(instance.type)
      warn(
        `Maximum recursive updates exceeded${
          componentName ? ` in component <${componentName}>` : ``
        }. ` +
          `This means you have a reactive effect that is mutating its own ` +
          `dependencies and thus recursively triggering itself. Possible sources ` +
          `include component template, render function, updated hook or ` +
          `watcher source function.`
      )
      return true
    } else {
      seen.set(fn, count + 1)
    }
  }
}
