import { toRaw, ReactiveFlags, toReactive, toReadonly } from './reactive'
import { track, trigger, ITERATE_KEY, MAP_KEY_ITERATE_KEY } from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { capitalize, hasOwn, hasChanged, toRawType, isMap } from '@vue/shared'

type CollectionTypes = IterableCollections | WeakCollections

type IterableCollections = Map<any, any> | Set<any>
type WeakCollections = WeakMap<any, any> | WeakSet<any>
type MapTypes = Map<any, any> | WeakMap<any, any>
type SetTypes = Set<any> | WeakSet<any>

const toShallow = <T extends unknown>(value: T): T => value

// 获取原型对象
const getProto = <T extends CollectionTypes>(v: T): any =>
  Reflect.getPrototypeOf(v)

function get(
  target: MapTypes,
  key: unknown,
  isReadonly = false,
  isShallow = false
) {

  /**
   * 1.针对readonly(reactive(new Map()))情况
   *   target指的是代理对象，rawTarget指的是原始map对象
   * 2.针对reactive(new Map())情况
   *   target和rawKey指的都是原始Map对象
   * */  
  target = (target as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  
  // map的键可以是对象，所以键也可能是代理对象  
  const rawKey = toRaw(key)
  // 如果不是只读的  
  if (!isReadonly) {
    // 若key是代理对象，则将副作用函数与key建立联系
    if (hasChanged(key, rawKey)) {
      track(rawTarget, TrackOpTypes.GET, key)
    }
    // 将副作用函数与rawKey建立联系  
    track(rawTarget, TrackOpTypes.GET, rawKey)
  }
  // 获取rawTarget原型上的has方法  
  const { has } = getProto(rawTarget)
  
  // 确定代理模式
  /**
   * toReadonly只读代理
   * toReactive普通代理
   * toShallow什么都不做
   * */  
  const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
  
  // 如果第一个条件成功，说明此时是reactive(new Map())情况
  if (has.call(rawTarget, key)) {
    // wrap根据值决定返回代理对象还是普通值
    return wrap(target.get(key))
  }
  // 如果进行第二个条件判断并成功，说明此时是readonly(reactive(new Map()))情况
  else if (has.call(rawTarget, rawKey)) {
    // wrap根据值决定返回代理对象还是普通值
    return wrap(target.get(rawKey))
  }
  else if (target !== rawTarget) {
    /**
     * 针对readonly(reactive(new Map()))，即使没有匹配的键值对，也要跟踪对响应式对象某键的依赖信息
     * const state = reactive(new Map())
     * const readonlyState = readonly(state)
     * 
     * effect(() => {
     *  console.log(readonlyState.get('foo'))
     * })
     * // 打印 undefined
     * state.set('foo', 1)
     * // 打印 1
     */

    target.get(key)
  }
}

function has(this: CollectionTypes, key: unknown, isReadonly = false): boolean {
  // 也是上面两种情况  
  const target = (this as any)[ReactiveFlags.RAW]
  const rawTarget = toRaw(target)
  const rawKey = toRaw(key)
  if (!isReadonly) {
    if (hasChanged(key, rawKey)) {
      track(rawTarget, TrackOpTypes.HAS, key)
    }
    track(rawTarget, TrackOpTypes.HAS, rawKey)
  }
  
  return key === rawKey
    ? target.has(key)
    // 解决查找的值是代理对象和普通对象的情况
    : target.has(key) || target.has(rawKey)
}

// p133
function size(target: IterableCollections, isReadonly = false) {
  target = (target as any)[ReactiveFlags.RAW]
  // 与访问size有关的副作用函数，当长度变化时就需要重新执行，ITERATE_KEY专门用来建立与长度有关的副作用函数之间的联系
  !isReadonly && track(toRaw(target), TrackOpTypes.ITERATE, ITERATE_KEY)
  // size在集合类型中是访问器属性，代理集合类型数据不设置拦截器时
  // 根据规范，需要访问this上的[[setData]]这个内部槽，如果写成Reflect.get(target, 'size', receiver)
  // 这个this就是代理对象，而代理对象上没有[[setData]]，所以此时会报错
  // 为了正常执行，只要把this指定为原始的数据就可以，因此通过下面这种写法，指定this为原始的数据  
  return Reflect.get(target, 'size', target)
}

// 针对Set类型的add方法的重写，即实现对add方法的代理
function add(this: SetTypes, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const proto = getProto(target)
  const hadKey = proto.has.call(target, value)
  // 如果新添加的值不存在  
  if (!hadKey) {
    // 则调用原生add方法，添加到原始数据上
    target.add(value)
    // 并触发与添加有关的副作用函数重新执行
    trigger(target, TriggerOpTypes.ADD, value, value)
  }
  return this
}

// 针对Map类型的set方法的重写，即实现对set方法的代理
function set(this: MapTypes, key: unknown, value: unknown) {
  value = toRaw(value)
  const target = toRaw(this)
  const { has, get } = getProto(target)

  // 判断设置的键是否存在，以此来判断是ADD操作，还是SET操作
  let hadKey = has.call(target, key)
  
  if (!hadKey) {
    // 第一次判断不存在，key可能为代理对象
    // 需要进行第二次判断，来确保key是否真正存在
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }

  const oldValue = get.call(target, key)
  // 设置值  
  target.set(key, value)
  // 此键值对如果原本是不存在的，则还需要重新执行与ADD有关的副作用函数的执行
  if (!hadKey) {
    trigger(target, TriggerOpTypes.ADD, key, value)
  } else if (hasChanged(value, oldValue)) {
    // 如果键值对原本就存在，且新值和旧值不同，则需要触发与key有关的副作用函数重新执行
    trigger(target, TriggerOpTypes.SET, key, value, oldValue)
  }
  return this
}

// 属性删除代理
function deleteEntry(this: CollectionTypes, key: unknown) {
  // 和set中的前部分代码作用相同  
  const target = toRaw(this)
  const { has, get } = getProto(target)
  let hadKey = has.call(target, key)
  if (!hadKey) {
    key = toRaw(key)
    hadKey = has.call(target, key)
  } else if (__DEV__) {
    checkIdentityKeys(target, has, key)
  }
  
  //   
  const oldValue = get ? get.call(target, key) : undefined
  // forward the operation before queueing reactions
  const result = target.delete(key)
  if (hadKey) {
    // 要删除的属性存在，删除属性后还要触发与该属性相关的副作用函数
    trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
  }
  return result
}

// 清空的代理
function clear(this: IterableCollections) {
  const target = toRaw(this)
  const hadItems = target.size !== 0
  const oldTarget = __DEV__
    ? isMap(target)
      ? new Map(target)
      : new Set(target)
    : undefined
  // forward the operation before queueing reactions
  const result = target.clear()
  // 如果有数据
  if (hadItems) {
    // 清除完数据之后，还要触发响应的副作用函数的执行，如该操作影响长度，会触发与ITERATE_KEY相关的副作用函数执行
    trigger(target, TriggerOpTypes.CLEAR, undefined, undefined, oldTarget)
  }
  return result
}

// 返回对forEach函数的代理
function createForEach(isReadonly: boolean, isShallow: boolean) {
  return function forEach(
    this: IterableCollections,
    callback: Function,
    thisArg?: unknown
  ) {
    const observed = this as any
    const target = observed[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    
    // 确定代理模式
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    
    // 非只读，则建立副作用函数与ITERATE_KEY的响应联系，因为forEach的执行需要受到长度的影响
    !isReadonly && track(rawTarget, TrackOpTypes.ITERATE, ITERATE_KEY)
    
    return target.forEach((value: unknown, key: unknown) => {
      // p144进行wrap操作的原因：如果value变化后，forEach也需要重新遍历，这是value就需要是响应式的，才能满足需求
      // 手动调用callback，将wrap处理过后的值传递过去
      return callback.call(thisArg, wrap(value), wrap(key), observed)
    })
  }
}

// 可迭代协议：是指实现Symbol.iterator方法的对象
interface Iterable {
  [Symbol.iterator](): Iterator
}
// 迭代器协议：是指实现next方法的对象
interface Iterator {
  next(value?: any): IterationResult
}

interface IterationResult {
  value: any
  done: boolean
}

// 创建迭代器方法
// 用于对for...of循环遍历进行拦截
function createIterableMethod(
  method: string | symbol,
  isReadonly: boolean,
  isShallow: boolean
) {
    // 这个函数对keys，values，entries这三种迭代方法的代理，此函数返回重写后的迭代器
  return function (
    this: IterableCollections,
    ...args: unknown[]
  ): Iterable & Iterator {
    const target = (this as any)[ReactiveFlags.RAW]
    const rawTarget = toRaw(target)
    // 判断rawTarget是不是map类型
    const targetIsMap = isMap(rawTarget)
    
    // p147
    // 针对集合类型的entries迭代器方法和集合类型本身部署的Symbol.iterator方法
    // 因为Symbol与entries是等价的
    const isPair =
      method === 'entries' || (method === Symbol.iterator && targetIsMap)
      
    // 针对集合类型的keys迭代器方法
    const isKeyOnly = method === 'keys' && targetIsMap
    
    // 获取迭代器
    const innerIterator = target[method](...args)
    // 确定代理模式
    const wrap = isShallow ? toShallow : isReadonly ? toReadonly : toReactive
    
    // 不是只读的需要进行依赖收集
    !isReadonly &&
      track(
        rawTarget,
        TrackOpTypes.ITERATE,
        // p154
        // 对于entries和values方法，值变化需要触发依赖，对于keys方法值变化不需要触发依赖
        // 迭代器方法进行收集依赖时，如果将副作用函数都与ITETATE_KEY建立联系
        // 那么对于keys方法来说会造成不必要的更新，因此使用一个新的key将entries，values与keys的依赖分别进行收集
        isKeyOnly ? MAP_KEY_ITERATE_KEY : ITERATE_KEY
      )

    return {
      // iterator protocol
      next() {
        // 通过迭代器拿到结果
        const { value, done } = innerIterator.next()
        // done是true代理迭代完成，done是false代表没有迭代完成
        return done
          ? { value, done }
          : {  // isPair为true代表，此时迭代出的value是[key， val]类型，是对entries的处理
               // isPair为false代表，此时迭代出的value只是一个值或键，是对keys和values的处理           
              value: isPair ? [wrap(value[0]), wrap(value[1])] : wrap(value),
              done
            }
      },
      // iterable protocol
      [Symbol.iterator]() {
        return this
      }
    }
  }
}

function createReadonlyMethod(type: TriggerOpTypes): Function {
  return function (this: CollectionTypes, ...args: unknown[]) {
    if (__DEV__) {
      const key = args[0] ? `on key "${args[0]}" ` : ``
      console.warn(
        `${capitalize(type)} operation ${key}failed: target is readonly.`,
        toRaw(this)
      )
    }
    return type === TriggerOpTypes.DELETE
      ? false
      : type === TriggerOpTypes.CLEAR
        ? undefined
        : this
  }
}
// 对集合类型的不同代理类型，创建不同的拦截器工具
function createInstrumentations() {
  const mutableInstrumentations: Record<string, Function | number> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, false)
  }

  const shallowInstrumentations: Record<string, Function | number> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, false, true)
    },
    get size() {
      return size(this as unknown as IterableCollections)
    },
    has,
    add,
    set,
    delete: deleteEntry,
    clear,
    forEach: createForEach(false, true)
  }

  const readonlyInstrumentations: Record<string, Function | number> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, false)
  }

  const shallowReadonlyInstrumentations: Record<string, Function | number> = {
    get(this: MapTypes, key: unknown) {
      return get(this, key, true, true)
    },
    get size() {
      return size(this as unknown as IterableCollections, true)
    },
    has(this: MapTypes, key: unknown) {
      return has.call(this, key, true)
    },
    add: createReadonlyMethod(TriggerOpTypes.ADD),
    set: createReadonlyMethod(TriggerOpTypes.SET),
    delete: createReadonlyMethod(TriggerOpTypes.DELETE),
    clear: createReadonlyMethod(TriggerOpTypes.CLEAR),
    forEach: createForEach(true, true)
  }
    
  // keys、values、entries、Symbol.iterator 这几个iteratorMethods的拦截是通过一个 forEach 在初始化的时候加上去的由 createIterableMethod 这个方法创造
  const iteratorMethods = ['keys', 'values', 'entries', Symbol.iterator]
  iteratorMethods.forEach(method => {
    mutableInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      false
    )
    readonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      false
    )
    shallowInstrumentations[method as string] = createIterableMethod(
      method,
      false,
      true
    )
    shallowReadonlyInstrumentations[method as string] = createIterableMethod(
      method,
      true,
      true
    )
  })

  return [
    mutableInstrumentations,
    readonlyInstrumentations,
    shallowInstrumentations,
    shallowReadonlyInstrumentations
  ]
}

// 获取不同的拦截器工具
const [
  mutableInstrumentations,
  readonlyInstrumentations,
  shallowInstrumentations,
  shallowReadonlyInstrumentations
] = /* #__PURE__*/ createInstrumentations()

// 集合类型代理对象访问不同的方法时，get拦截器的具体实现
function createInstrumentationGetter(isReadonly: boolean, shallow: boolean) {
  // 根据传递的参数不同，创建不同代理类型的拦截器工具
  const instrumentations = shallow
    ? isReadonly
      ? shallowReadonlyInstrumentations
      : shallowInstrumentations
    : isReadonly
      ? readonlyInstrumentations
      : mutableInstrumentations

  return (
    target: CollectionTypes,
    key: string | symbol,
    receiver: CollectionTypes
  ) => {
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    } else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    } else if (key === ReactiveFlags.RAW) {
      return target
    }

    return Reflect.get(
      // 集合类型代理对象访问不同的方法，看看对应的instrumentations有没有，如果有，相当于取其自定义的拦截函数，如果没有就从原始数据target中获取
      hasOwn(instrumentations, key) && key in target
        ? instrumentations
        : target,
      key,
      receiver
    )
  }
}

// 为普通代理类型创建getter处理函数
export const mutableCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, false)
}

// 为浅响应代理类型创建getter处理函数
export const shallowCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(false, true)
}

// 为只读代理类型创建getter处理函数
export const readonlyCollectionHandlers: ProxyHandler<CollectionTypes> = {
  get: /*#__PURE__*/ createInstrumentationGetter(true, false)
}

// 为浅只读代理类型创建getter处理函数
export const shallowReadonlyCollectionHandlers: ProxyHandler<CollectionTypes> =
  {
    get: /*#__PURE__*/ createInstrumentationGetter(true, true)
  }

// 开发环境检查目标数据上面是否同时存在rawKey和key
function checkIdentityKeys(
  target: CollectionTypes,
  has: (key: unknown) => boolean,
  key: unknown
) {
  const rawKey = toRaw(key)
  if (rawKey !== key && has.call(target, rawKey)) {
    const type = toRawType(target)
    console.warn(
      `Reactive ${type} contains both the raw and reactive ` +
        `versions of the same object${type === `Map` ? ` as keys` : ``}, ` +
        `which can lead to inconsistencies. ` +
        `Avoid differentiating between the raw and reactive versions ` +
        `of an object and only use the reactive version if possible.`
    )
  }
}
