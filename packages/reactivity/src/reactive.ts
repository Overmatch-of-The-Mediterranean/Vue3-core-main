import { isObject, toRawType, def } from '@vue/shared'
import {
  mutableHandlers,
  readonlyHandlers,
  shallowReactiveHandlers,
  shallowReadonlyHandlers
} from './baseHandlers'
import {
  mutableCollectionHandlers,
  readonlyCollectionHandlers,
  shallowCollectionHandlers,
  shallowReadonlyCollectionHandlers
} from './collectionHandlers'
import type { UnwrapRefSimple, Ref, RawSymbol } from './ref'

// 标志位，用于判断是哪一类型的响应式对象
export const enum ReactiveFlags {
  SKIP = '__v_skip',
  IS_REACTIVE = '__v_isReactive',
  IS_READONLY = '__v_isReadonly',
  IS_SHALLOW = '__v_isShallow',
  RAW = '__v_raw'
}

export interface Target {
  [ReactiveFlags.SKIP]?: boolean
  [ReactiveFlags.IS_REACTIVE]?: boolean
  [ReactiveFlags.IS_READONLY]?: boolean
  [ReactiveFlags.IS_SHALLOW]?: boolean
  [ReactiveFlags.RAW]?: any
}

export const reactiveMap = new WeakMap<Target, any>()
export const shallowReactiveMap = new WeakMap<Target, any>()
export const readonlyMap = new WeakMap<Target, any>()
export const shallowReadonlyMap = new WeakMap<Target, any>()

// 把所有数据分为三种类型，只有COMMON和COLLECTION类型才能进行响应代理
const enum TargetType {
  INVALID = 0,
  COMMON = 1,
  COLLECTION = 2
}

// 对可以reactive的对象加了个白名单
// 只有Object，Array，Map，Set，WeakMap，WeakSet对象可以进行reactive操作
function targetTypeMap(rawType: string) {
  switch (rawType) {
    case 'Object':
    case 'Array':
      return TargetType.COMMON
    case 'Map':
    case 'Set':
    case 'WeakMap':
    case 'WeakSet':
      return TargetType.COLLECTION
    default:
      return TargetType.INVALID
  }
}

// 判断value是哪些类型，因为有些类型不能进行reactive，对应62行
function getTargetType(value: Target) {
  return value[ReactiveFlags.SKIP] || !Object.isExtensible(value)
    ? TargetType.INVALID
    : targetTypeMap(toRawType(value))
}


export type UnwrapNestedRefs<T> = T extends Ref ? T : UnwrapRefSimple<T>


export function reactive<T extends object>(target: T): UnwrapNestedRefs<T>

// reactive也就是调用createReactiveObject函数，返回proxy对象
export function reactive(target: object) {
  // 断传给reactive方法的参数是否已经被readonly方法处理过，如果已经被处理过，则直接返回
  if (isReadonly(target)) {
    return target
  }
  return createReactiveObject(
    target, // 被代理对象
    false, // isReadonly
    mutableHandlers, // 用proxy代理引用类型数据(对象，数组)的拦截器配置
    mutableCollectionHandlers,// 用Proxy代理集合类型的数据，使用的拦截器配置
    reactiveMap // 记录被代理对象与proxy的映射关系，实现复用同一对象的proxy
  )
}

export declare const ShallowReactiveMarker: unique symbol

export type ShallowReactive<T> = T & { [ShallowReactiveMarker]?: true }

// 浅响应式数据
export function shallowReactive<T extends object>(
  target: T
): ShallowReactive<T> {
  return createReactiveObject(
    target,
    false,// isReadonly
    shallowReactiveHandlers, // 引用类型实现浅响应，进行代理所用的浅响应的拦截器配置
    shallowCollectionHandlers, // 集合类型实现浅响应，进行代理所用的浅响应的拦截器配置
    shallowReactiveMap // 记录被代理对象与proxy的映射关系，实现复用同一对象的proxy
  )
}

type Primitive = string | number | boolean | bigint | symbol | undefined | null
type Builtin = Primitive | Function | Date | Error | RegExp
export type DeepReadonly<T> = T extends Builtin
  ? T
  : T extends Map<infer K, infer V>
    ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
    : T extends ReadonlyMap<infer K, infer V>
      ? ReadonlyMap<DeepReadonly<K>, DeepReadonly<V>>
      : T extends WeakMap<infer K, infer V>
        ? WeakMap<DeepReadonly<K>, DeepReadonly<V>>
        : T extends Set<infer U>
          ? ReadonlySet<DeepReadonly<U>>
          : T extends ReadonlySet<infer U>
            ? ReadonlySet<DeepReadonly<U>>
            : T extends WeakSet<infer U>
              ? WeakSet<DeepReadonly<U>>
              : T extends Promise<infer U>
                ? Promise<DeepReadonly<U>>
                : T extends Ref<infer U>
                  ? Readonly<Ref<DeepReadonly<U>>>
                  : T extends {}
                    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
                    : Readonly<T>


// 实现深只读
export function readonly<T extends object>(
  target: T
): DeepReadonly<UnwrapNestedRefs<T>> {
  return createReactiveObject(
    target,
    true, // isReadonly
    readonlyHandlers,// 引用类型实现深只读，进行代理时所用的拦截器配置
    readonlyCollectionHandlers,// 集合类型实现深只读，进行代理时所用的拦截器配置
    readonlyMap // 记录被代理对象与proxy的映射关系，实现复用同一对象的proxy
  )
}

// 实现浅只读
export function shallowReadonly<T extends object>(target: T): Readonly<T> {
  return createReactiveObject(
    target,
    true,
    shallowReadonlyHandlers, // 引用类型实现浅只读，进行代理时所用的拦截器配置
    shallowReadonlyCollectionHandlers, // 集合类型实现浅只读，进行代理时所用的拦截器配置
    shallowReadonlyMap // 记录被代理对象与proxy的映射关系，实现复用同一对象的proxy
  )
}

// 实现响应的核心方法
function createReactiveObject(
  target: Target, 
  isReadonly: boolean,
  baseHandlers: ProxyHandler<any>,
  collectionHandlers: ProxyHandler<any>,
  proxyMap: WeakMap<Target, any>
) {
  // 因为Proxy只能代理对象，所以传递的如果不是对象类型会报警告  
  if (!isObject(target)) {
    if (__DEV__) {
      console.warn(`value cannot be made reactive: ${String(target)}`)
    }
    return target
  }
    
  // target is already a Proxy, return it.
  // exception: calling readonly() on a reactive object
  // 有target[ReactiveFlags.RAW 证明已经是一个响应式代理
  // 除非是对一个 reactive 对象调用 readonly，否则直接返回。 readonly(reactive)
  if (
    target[ReactiveFlags.RAW] &&
    !(isReadonly && target[ReactiveFlags.IS_REACTIVE])
  ) {
    return target
  }
  
  // 如果target已经有对应的代理对象，这复用这个代理对象  
  const existingProxy = proxyMap.get(target)
  if (existingProxy) {
    return existingProxy
  }
    
    
  // only specific value types can be observed.
  // 判断 target是否属于能转换为响应式代理的类型  
  // 只有Object，Array，Map，Set，WeakMap，WeakSet对象可以进行代理操作
  // 其余类型都是无效类型，不能进行代理操作   
  const targetType = getTargetType(target)
  if (targetType === TargetType.INVALID) {
    return target
  }
    
  // 对传入的数据进行代理，也就是传换为响应式数据
  const proxy = new Proxy(
    target,
    targetType === TargetType.COLLECTION ? collectionHandlers : baseHandlers
  )
  // 保存target与proxy的对应关系，方便复用，提高性能
  proxyMap.set(target, proxy)
  return proxy
}

/**
 * ```js
 * isReactive(reactive({}))            // => true
 * isReactive(readonly(reactive({})))  // => true
 * isReactive(ref({}).value)           // => true
 * isReactive(readonly(ref({})).value) // => true
 * isReactive(ref(true))               // => false
 * isReactive(shallowRef({}).value)    // => false
 * isReactive(shallowReactive({}))     // => true
 * ```
 */

// 检查一个对象是否是由 reactive 创建的响应式代理
// (value as Target)[ReactiveFlags.IS_REACTIVE]：说明 target 就是一个 reactive对象，返回 true
// (value as Target)[ReactiveFlags.IS_READONLY] && isReactive((value as Target)[ReactiveFlags.RAW]) 说明是一个 readonly(reactive) 的嵌套对象，也返回 true；
export function isReactive(value: unknown): boolean {
  if (isReadonly(value)) {
    return isReactive((value as Target)[ReactiveFlags.RAW])
  }
  return !!(value && (value as Target)[ReactiveFlags.IS_REACTIVE])
}


// 检查一个对象是否是由 readonly 创建的只读代理
// 就是通过 ReactiveFlags.IS_READONLY 这个标志位，其实这个标志位是通过在 getter 里设置拦截实现的
export function isReadonly(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_READONLY])
}

// 检查一个对象是否是浅响应式的代理
export function isShallow(value: unknown): boolean {
  return !!(value && (value as Target)[ReactiveFlags.IS_SHALLOW])
}

/**
 * Checks if an object is a proxy created by {@link reactive},
 * {@link readonly}, {@link shallowReactive} or {@link shallowReadonly()}.
 */
// 查看是否设置任意一种代理
export function isProxy(value: unknown): boolean {
  return isReactive(value) || isReadonly(value)
}


// toRaw 返回代理对象对应的实际对象，如果嵌套了多层代理，返回最终的实际对象，RAW 标志位也是通过在 getter 里设置拦截实现的。
export function toRaw<T>(observed: T): T {
  // (observed)代理对象的的ReactiveFlags.RAW属性可以返回对象的原始对象。 
  const raw = observed && (observed as Target)[ReactiveFlags.RAW]
  // 但这个原始对象有可能也是可以响应式对象（如readonly(reactive(obj))），所以递归调用toRaw，以获取真正的原始对象。 
  return raw ? toRaw(raw) : observed
}

export type Raw<T> = T & { [RawSymbol]?: true }

// 显式标记一个对象为“永远不会转为响应式代理”，函数返回这个对象本身。
// 就是给这个对象添加一个 ReactiveFlags.SKIP 标志位
export function markRaw<T extends object>(value: T): Raw<T> {
  def(value, ReactiveFlags.SKIP, true)
  return value
}


// 用于ref中，如果ref传入的是引用类型，则其内部调用toReactive，还是用reactive那一套进行处理
export const toReactive = <T extends unknown>(value: T): T =>
  isObject(value) ? reactive(value) : value


export const toReadonly = <T extends unknown>(value: T): T =>
  isObject(value) ? readonly(value) : value
