import { TrackOpTypes, TriggerOpTypes } from './operations'
import { extend, isArray, isIntegerKey, isMap, isSymbol } from '@vue/shared'
import { EffectScope, recordEffectScope } from './effectScope'
import {
  createDep,
  Dep,
  finalizeDepMarkers,
  initDepMarkers,
  newTracked,
  wasTracked
} from './dep'
import { ComputedRefImpl } from './computed'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
type KeyToDepMap = Map<any, Dep>
const targetMap = new WeakMap<object, KeyToDepMap>()

// 表示递归调用effect函数的深度
let effectTrackDepth = 0

// 用于标识依赖收集的状态
export let trackOpBit = 1

const maxMarkerBits = 30

export type EffectScheduler = (...args: any[]) => any

export type DebuggerEvent = {
  effect: ReactiveEffect
} & DebuggerEventExtraInfo

export type DebuggerEventExtraInfo = {
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}
// 存储当前激活的副作用函数
export let activeEffect: ReactiveEffect | undefined
// 受长度影响的副作用函数，与ITERATE_KEY建立联系
export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
// 依赖收集的分离，集合类型的keys方法有关的副作用函数都与MAP_KEY_ITERATE_KEY 建立联系
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

// 创建副作用函数的类
export class ReactiveEffect<T = any> {
  active = true
  deps: Dep[] = []
  parent: ReactiveEffect | undefined = undefined

  /**
   * Can be attached after creation
   * @internal
   */
  computed?: ComputedRefImpl<T>
  /**
   * @internal
   */
  allowRecurse?: boolean
  /**
   * @internal
   */
  private deferStop?: boolean

  onStop?: () => void
  // dev only
  onTrack?: (event: DebuggerEvent) => void
  // dev only
  onTrigger?: (event: DebuggerEvent) => void

  constructor(
    public fn: () => T,
    public scheduler: EffectScheduler | null = null,
    scope?: EffectScope
  ) {
    recordEffectScope(this, scope)
  }
  // 封装副作用函数
  run() {
    if (!this.active) {
      return this.fn()
    }
    // 存储上一层的副作用函数
    let parent: ReactiveEffect | undefined = activeEffect
    // 记录上一层副作用函数是否可收集
    let lastShouldTrack = shouldTrack

    // 保证parent是上一层的副作用函数
    while (parent) {
      if (parent === this) {
        return
      }
      parent = parent.parent
    }
    try {
      // 这里使用this.parent和lastShouldTrack来代替effectStack，实现栈的功能
      // 记录上一层的副作用函数
      this.parent = activeEffect
      // 调用effect注册的副作用函数时，将副作用函数存放在activeEffect中，表示激活的副作用函数
      activeEffect = this
      // 当前状态改为可以收集依赖
      shouldTrack = true
      // effect嵌套情况，组件嵌套使用时，就是effect的嵌套
      // 将嵌套的effect依次推入栈(逻辑上的)中，增加递归嵌套调用的深度
      // trackOpBit结合位运算的设计，可以记录每个层级依赖标记情况
      trackOpBit = 1 << ++effectTrackDepth

      if (effectTrackDepth <= maxMarkerBits) {
        // 给依赖打标记
        initDepMarkers(this)
      } else {
        // 书上cleanupEffect的作用是每次执行effect前，先将副作用函数从依赖集合中删除，在副作用函数执行的过程中重新收集依赖
        // 书上的实现是之前的实现，性能没有优化
        // 现在只有超过 maxMarkerBits 则 trackOpBit 的计算会超过最大整形的位数，才会降级为 cleanupEffect
        cleanupEffect(this)
      }
      // 执行真正的副作用函数
      return this.fn()
    } finally {
      if (effectTrackDepth <= maxMarkerBits) {
        // 真正对依赖收集进行性能优化的关键代码是这个函数
        finalizeDepMarkers(this)
      }
      // 当前层级副作用函数执行完毕后，返回到上一层需要做的处理
      // 首先递归深度减一，其次用来依赖标记的trackOpBit也回退一位
      trackOpBit = 1 << --effectTrackDepth
      // 让activeEffect指向上一层的副作用函数，即总是指向栈顶副作用函数
      activeEffect = this.parent
      // 并恢复栈顶副作用是否可收集的状态
      shouldTrack = lastShouldTrack
      this.parent = undefined

      if (this.deferStop) {
        this.stop()
      }
    }
  }

  // 停止对该副作用函数的收集，将副作用函数从对应的依赖集合中删除
  // stop后，某些值就不是响应式的了
  stop() {
    if (activeEffect === this) {
      this.deferStop = true
    }
    // 通过active，实现多次调用stop，只进行清空一次的效果
    // 一个effect调用一次stop就可以达到目的了，多次调用若不加限制，会造成性能损耗，active就是限制
    else if (this.active) {
      cleanupEffect(this)
      if (this.onStop) {
        this.onStop()
      }
      this.active = false
    }
  }
}

// 将此副作用函数从与其有关的依赖集合中删除掉
// p50
// 可以解决分支切换存在副作用残留问题
function cleanupEffect(effect: ReactiveEffect) {
  // 依赖了该副作用函数的集合
  const { deps } = effect
  if (deps.length) {
    // 遍历每个集合，从中删除掉该副作用函数
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    // 清空存储所有与该副作用函数相关联的依赖集合
    deps.length = 0
  }
}

export interface DebuggerOptions {
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
}

// effect可传入的配置项
export interface ReactiveEffectOptions extends DebuggerOptions {
  lazy?: boolean // 懒执行，computed中会用到
  scheduler?: EffectScheduler // 调度器，许多功能的实现都依赖它
  scope?: EffectScope
  allowRecurse?: boolean
  onStop?: () => void // 相当于执行stop操作后的一个回调函数，允许用户做一些额外的处理，若有onStop，其在stop执行后会自动执行
}

export interface ReactiveEffectRunner<T = any> {
  (): T
  effect: ReactiveEffect
}

// 注册副作用函数
export function effect<T = any>(
  fn: () => T,
  options?: ReactiveEffectOptions
): ReactiveEffectRunner {
  if ((fn as ReactiveEffectRunner).effect instanceof ReactiveEffect) {
    fn = (fn as ReactiveEffectRunner).effect.fn
  }
  // 对副作用函数的封装
  const _effect = new ReactiveEffect(fn)

  if (options) {
    // p61
    // 将参数与副作用函数合并
    extend(_effect, options)
    if (options.scope) recordEffectScope(_effect, options.scope)
  }
  // 如果effect没有配置参数或者配置的lazy为false，则直接执行副作用函数
  if (!options || !options.lazy) {
    _effect.run()
  }

  // 如果options.lazy为true，则将副作用函数存储起来并返回，在需要的地方可以手动调用副作用函数
  // 如在computed中手动调用副作用函数
  const runner = _effect.run.bind(_effect) as ReactiveEffectRunner
  // 为了调用effect的stop方法，需要进行这个赋值
  runner.effect = _effect
  return runner
}

export function stop(runner: ReactiveEffectRunner) {
  runner.effect.stop()
}

// 代表是否可追踪，默认值为true，代表允许追踪
export let shouldTrack = true
// 记录每个副作用函数是否进行追踪的状态栈
const trackStack: boolean[] = []

//129
// 针对于隐式修改数组长度的原型方法(push, pop , shift, unshift等)
// 在执行方法前禁止追踪
export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

/**
 * Re-enables effect tracking (if it was paused).
 */
// 执行数组原型方法后，可以追踪
export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

/**
 * Resets the previous global effect tracking state.
 */

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

// 能正确建立响应联系的数据结构
/**
 *  target-->key-->effectFn
    WeakMap-->Map-->Set
    WeakMap由target-->Map组成
    Map由key-->set构成
 * */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  if (shouldTrack && activeEffect) {
    // 获取target的所有属性到依赖集合的映射
    let depsMap = targetMap.get(target)
    if (!depsMap) {
      // 如果不存在，则新建一个
      targetMap.set(target, (depsMap = new Map()))
    }
    // 获取key对应的依赖集合
    let dep = depsMap.get(key)
    if (!dep) {
      // 如果不存在，则新建一个
      depsMap.set(key, (dep = createDep()))
    }

    const eventInfo = __DEV__
      ? { effect: activeEffect, target, type, key }
      : undefined
    // 将副作用函数收集到key对应的依赖集合中
    trackEffects(dep, eventInfo)
  }
}

export function trackEffects(
  dep: Dep,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  let shouldTrack = false
  if (effectTrackDepth <= maxMarkerBits) {
    // !newTracked(dep)为true意味着，此副作用函数已经存在于dep中
    if (!newTracked(dep)) {
      // 如果这个这个副作用函数已经被收集，新一轮依赖收集中还需要被收集的话
      // 将依赖收集的状态改为新的，意味着新一轮依赖收集中，副作用函数还需要被收集到这个dep中
      // 从而减少对dep的删除和增加操作
      dep.n |= trackOpBit
      // 副作用函数已经存在于dep中，也就不需要再追踪了
      shouldTrack = !wasTracked(dep)
    }
  } else {
    // 意味着该副作用函数还未与当前dep有联系，将shouldTrack改为true，允许追踪
    shouldTrack = !dep.has(activeEffect!)
  }

  if (shouldTrack) {
    // 往依赖集合中添加副作用函数
    dep.add(activeEffect!)
    // 同时记录副作用函数都在哪些依赖集合中
    activeEffect!.deps.push(dep)
    if (__DEV__ && activeEffect!.onTrack) {
      activeEffect!.onTrack(
        extend(
          {
            effect: activeEffect!
          },
          debuggerEventExtraInfo!
        )
      )
    }
  }
}

export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 获取key对应的依赖集合
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }

  let deps: (Dep | undefined)[] = []
  if (type === TriggerOpTypes.CLEAR) {
    // collection being cleared
    // trigger all effects for target
    deps = [...depsMap.values()]
  } else if (key === 'length' && isArray(target)) {
    // 针对于直接修改数组长度也会影响元素的情况
    const newLength = Number(newValue)
    // 当修改数组长度时，只有索引大于数组长度的元素才需要触发响应
    depsMap.forEach((dep, key) => {
      if (key === 'length' || (!isSymbol(key) && key >= newLength)) {
        deps.push(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    if (key !== void 0) {
      deps.push(depsMap.get(key))
    }

    // 对不同触发类型，收集其需要执行的副作用函数
    switch (type) {
      // 新增元素值操作相关的副作用函数的触发
      case TriggerOpTypes.ADD:
        if (!isArray(target)) {
          // 添加元素后长度会变化
          // target不是数组，而是对象和集合数据类型，与长度有关的副作用函数通过ITERATE_KEY触发
          deps.push(depsMap.get(ITERATE_KEY))
          // 如果是集合数据类型，对于keys相关的副作用函数需要通过MAP_KEY_ITERATE_KEY触发
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 通过索引设置元素，索引值大于数组长度
          deps.push(depsMap.get('length'))
        }
        break

      // 删除元素值操作相关的副作用函数的触发
      case TriggerOpTypes.DELETE:
        if (!isArray(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            deps.push(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break

      // 设置元素值操作相关的副作用函数的触发
      // 比如使用for...in/of，forEach方法的副作用函数需要与ITERATE_KEY建立联系
      // 当元素值发生变化后，需要通过ITERATE_KEY取出这些副作用函数执行
      case TriggerOpTypes.SET:
        if (isMap(target)) {
          deps.push(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }

  const eventInfo = __DEV__
    ? { target, type, key, newValue, oldValue, oldTarget }
    : undefined

  if (deps.length === 1) {
    if (deps[0]) {
      if (__DEV__) {
        triggerEffects(deps[0], eventInfo)
      } else {
        triggerEffects(deps[0])
      }
    }
  } else {
    // 存储本次触发需要执行的副作用函数
    const effects: ReactiveEffect[] = []
    // 整理本次触发需要执行的副作用函数
    for (const dep of deps) {
      if (dep) {
        effects.push(...dep)
      }
    }
    if (__DEV__) {
      triggerEffects(createDep(effects), eventInfo)
    } else {
      triggerEffects(createDep(effects))
    }
  }
}

export function triggerEffects(
  dep: Dep | ReactiveEffect[],
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  // spread into array for stabilization
  const effects = isArray(dep) ? dep : [...dep]
  for (const effect of effects) {
    if (effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
  for (const effect of effects) {
    if (!effect.computed) {
      triggerEffect(effect, debuggerEventExtraInfo)
    }
  }
}

// 触发每个副作用函数执行
function triggerEffect(
  effect: ReactiveEffect,
  debuggerEventExtraInfo?: DebuggerEventExtraInfo
) {
  if (effect !== activeEffect || effect.allowRecurse) {
    if (__DEV__ && effect.onTrigger) {
      effect.onTrigger(extend({ effect }, debuggerEventExtraInfo))
    }
    // 副作用函数要是有调度器函数，则执行调度器函数
    if (effect.scheduler) {
      effect.scheduler()
    }
    // 否则，执行副作用函数
    else {
      effect.run()
    }
  }
}

export function getDepFromReactive(object: any, key: string | number | symbol) {
  return targetMap.get(object)?.get(key)
}
