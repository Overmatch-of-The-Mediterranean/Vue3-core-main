import type { ComputedRef } from './computed'
import {
  activeEffect,
  getDepFromReactive,
  shouldTrack,
  trackEffects,
  triggerEffects
} from './effect'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import { isArray, hasChanged, IfAny, isFunction, isObject } from '@vue/shared'
import {
  isProxy,
  toRaw,
  isReactive,
  toReactive,
  isReadonly,
  isShallow
} from './reactive'
import type { ShallowReactiveMarker } from './reactive'
import { createDep, Dep } from './dep'

declare const RefSymbol: unique symbol
export declare const RawSymbol: unique symbol

export interface Ref<T = any> {
  value: T
  /**
   * Type differentiator only.
   * We need this to be in public d.ts but don't want it to show up in IDE
   * autocomplete, so we use a private Symbol instead.
   */
  [RefSymbol]: true
}

type RefBase<T> = {
  dep?: Dep
  value: T
}

// 收集依赖
export function trackRefValue(ref: RefBase<any>) {
  // 形参ref指的是ref类型的值
  // 如果当前允许追踪，且activeEffect中有副作用函数，则进行依赖收集
  if (shouldTrack && activeEffect) {
    // 转换成原始数据，原始数据是值类型包装了一层对象，如：{ value:xxx }
    ref = toRaw(ref)
    if (__DEV__) {
      trackEffects(ref.dep || (ref.dep = createDep()), {
        target: ref,
        type: TrackOpTypes.GET,
        key: 'value'
      })
    } else {
      // 将收集的副作用函数放在原始值的dep属性上
      trackEffects(ref.dep || (ref.dep = createDep()))
    }
  }
}

/**
 * 做了两件事
 * 1.获取依赖集合
 * 2.触发依赖
*/
export function triggerRefValue(ref: RefBase<any>, newVal?: any) {
  // 形参ref指的是ref类型的值  
  ref = toRaw(ref)
  // 得到原始值对应的依赖集合
  const dep = ref.dep
  if (dep) {
    // 开发阶段处理
    if (__DEV__) {
      triggerEffects(dep, {
        target: ref,
        type: TriggerOpTypes.SET,
        key: 'value',
        newValue: newVal
      })
    } else {
      // 如果有相关的副作用函数，就触发重新执行
      triggerEffects(dep)
    }
  }
}


export function isRef<T>(r: Ref<T> | unknown): r is Ref<T>

// 通过__v_isRef检查是否是ref
export function isRef(r: any): r is Ref {
  return !!(r && r.__v_isRef === true)
}


export function ref<T>(value: T): Ref<UnwrapRef<T>>
export function ref<T = any>(): Ref<T | undefined>

// ref创建响应式对象
export function ref(value?: unknown) {
  return createRef(value, false)
}

declare const ShallowRefMarker: unique symbol

export type ShallowRef<T = any> = Ref<T> & { [ShallowRefMarker]?: true }


export function shallowRef<T>(value: MaybeRef<T>): Ref<T> | ShallowRef<T>
export function shallowRef<T extends Ref>(value: T): T
export function shallowRef<T>(value: T): ShallowRef<T>
export function shallowRef<T = any>(): ShallowRef<T | undefined>

// 阻止其将内部的元素转换为 reactive
export function shallowRef(value?: unknown) {
  return createRef(value, true)
}

// 实现ref的核心函数
function createRef(rawValue: unknown, shallow: boolean) {
  // 传入的值是ref直接返回  
  if (isRef(rawValue)) {
    return rawValue
  }
    
  return new RefImpl(rawValue, shallow)
}

class RefImpl<T> {
  private _value: T
  private _rawValue: T
  
  // 收集副作用函数的set集合
  public dep?: Dep = undefined
  public readonly __v_isRef = true

  constructor(
    value: T,
    public readonly __v_isShallow: boolean
  ) {
    // 获取传入值的原始值
    this._rawValue = __v_isShallow ? value : toRaw(value)
    // 传入的值如果是引用数据类型，还是使用reactive进行响应式处理
    this._value = __v_isShallow ? value : toReactive(value)
  }
  
  // 对于值类型的响应式，ref本质上是通过getter和setter实现的  
  get value() {
    // 通过.value访问ref数据会收集依赖
    trackRefValue(this)
    return this._value
  }

  set value(newVal) {
    // 判断新值的类型
    const useDirectValue =
      this.__v_isShallow || isShallow(newVal) || isReadonly(newVal)
    // 得到新值的原始数据
    newVal = useDirectValue ? newVal : toRaw(newVal)
    // 比较新值和旧值是否相等
    if (hasChanged(newVal, this._rawValue)) {
      // 如果不相等，进行相应赋值操作  
      this._rawValue = newVal
      // 根据响应类型进行处理，如果是浅层ref或只读，则使用原值；否则使用reactive处理过后的代理对象
      this._value = useDirectValue ? newVal : toReactive(newVal)
      // 重新执行相关副作用函数
      triggerRefValue(this, newVal)
    }
  }
}


export function triggerRef(ref: Ref) {
  triggerRefValue(ref, __DEV__ ? ref.value : void 0)
}

export type MaybeRef<T = any> = T | Ref<T>
export type MaybeRefOrGetter<T = any> = MaybeRef<T> | (() => T)


// 自动脱ref
export function unref<T>(ref: MaybeRef<T> | ComputedRef<T>): T {
  return isRef(ref) ? ref.value : ref
}


export function toValue<T>(source: MaybeRefOrGetter<T> | ComputedRef<T>): T {
  return isFunction(source) ? source() : unref(source)
}

const shallowUnwrapHandlers: ProxyHandler<any> = {
  // 在模板中使用，可以自动脱ref
  get: (target, key, receiver) => unref(Reflect.get(target, key, receiver)),
  // 设置值，也可以直接设置，不用.value  
  set: (target, key, value, receiver) => {
    const oldValue = target[key]
    // 对于旧值是ref，新值不是ref的处理，让用户使用时不用.value
    if (isRef(oldValue) && !isRef(value)) {
      oldValue.value = value
      return true
    } else {
      return Reflect.set(target, key, value, receiver)
    }
  }
}

// p165
// setup函数返回的对象，就是传递给proxyRefs，为setup返回的对象进行一层代理
// proxyRefs
export function proxyRefs<T extends object>(
  objectWithRefs: T
): ShallowUnwrapRef<T> {
  return isReactive(objectWithRefs)
    ? objectWithRefs // 此时说明传入的值已经是代理后的对象
    : new Proxy(objectWithRefs, shallowUnwrapHandlers) // 此时说明是普通对象，需要进行代理
}

export type CustomRefFactory<T> = (
  track: () => void,
  trigger: () => void
) => {
  get: () => T
  set: (value: T) => void
}

class CustomRefImpl<T> {
  public dep?: Dep = undefined

  private readonly _get: ReturnType<CustomRefFactory<T>>['get']
  private readonly _set: ReturnType<CustomRefFactory<T>>['set']

  public readonly __v_isRef = true

  constructor(factory: CustomRefFactory<T>) {
    const { get, set } = factory(
      () => trackRefValue(this),
      () => triggerRefValue(this)
    )
    this._get = get
    this._set = set
  }

  get value() {
    return this._get()
  }

  set value(newVal) {
    this._set(newVal)
  }
}

// 用于自定义一个 ref，可以显式地控制依赖追踪和触发响应
// 接受一个工厂函数，两个参数分别是用于追踪的 track 与用于触发响应的 trigger
// 并返回一个一个带有 get 和 set 属性的对象
export function customRef<T>(factory: CustomRefFactory<T>): Ref<T> {
  return new CustomRefImpl(factory) as any
}

export type ToRefs<T = any> = {
  [K in keyof T]: ToRef<T[K]>
}

// p160
// 解决响应式丢失问题，将响应式数据转换成类似于ref结构的数据
// const obj = reactive({ foo:1, bar:2 }) toRefs处理后
/*
    {
      foo:{
        get value() {
          return obj.foo
        }
      },
      bar:{
        get value() {
          return obj.foo
        }
      }
    }
*/
export function toRefs<T extends object>(object: T): ToRefs<T> {
  if (__DEV__ && !isProxy(object)) {
    console.warn(`toRefs() expects a reactive object but received a plain one.`)
  }
  
  const ret: any = isArray(object) ? new Array(object.length) : {}
  for (const key in object) {
    ret[key] = propertyToRef(object, key)
  }
  return ret
}

// 定义ref结构的数据的类
class ObjectRefImpl<T extends object, K extends keyof T> {
  public readonly __v_isRef = true

  constructor(
    private readonly _object: T,
    private readonly _key: K,
    private readonly _defaultValue?: T[K]
  ) {}

  get value() {
    const val = this._object[this._key]
    return val === undefined ? this._defaultValue! : val
  }

  set value(newVal) {
    this._object[this._key] = newVal
  }

  get dep(): Dep | undefined {
    return getDepFromReactive(toRaw(this._object), this._key)
  }
}

class GetterRefImpl<T> {
  public readonly __v_isRef = true
  public readonly __v_isReadonly = true
  constructor(private readonly _getter: () => T) {}
  get value() {
    return this._getter()
  }
}

export type ToRef<T> = IfAny<T, Ref<T>, [T] extends [Ref] ? T : Ref<T>>

// 可以用来为一个对象的属性创建一个 ref。这个 ref 可以被传递并且能够保持响应性
export function toRef<T>(
  value: T
): T extends () => infer R
  ? Readonly<Ref<R>>
  : T extends Ref
    ? T
    : Ref<UnwrapRef<T>>
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K
): ToRef<T[K]>
export function toRef<T extends object, K extends keyof T>(
  object: T,
  key: K,
  defaultValue: T[K]
): ToRef<Exclude<T[K], undefined>>
export function toRef(
  source: Record<string, any> | MaybeRef,
  key?: string,
  defaultValue?: unknown
): Ref {
  // 如果传入ref值，则直接返回
  if (isRef(source)) {
    return source
  } else if (isFunction(source)) {
    return new GetterRefImpl(source) as any
  }
  // 对象类型，转化成ref结构
  else if (isObject(source) && arguments.length > 1) {
    return propertyToRef(source, key!, defaultValue)
  } else {
    return ref(source)
  }
}

// 将reactive值的对应属性转换成ref结构 { get value () { return obj[key] } }
function propertyToRef(
  source: Record<string, any>,
  key: string,
  defaultValue?: unknown
) {
  const val = source[key]
  return isRef(val)
    ? val // 如果是ref则直接返回
    // 不是ref，构造成ref结构，返回{ get value () { return obj[key] } }
    : (new ObjectRefImpl(source, key, defaultValue) as any)
}

// corner case when use narrows type
// Ex. type RelativePath = string & { __brand: unknown }
// RelativePath extends object -> true
type BaseTypes = string | number | boolean

/**
 * This is a special exported interface for other packages to declare
 * additional types that should bail out for ref unwrapping. For example
 * \@vue/runtime-dom can declare it like so in its d.ts:
 *
 * ``` ts
 * declare module '@vue/reactivity' {
 *   export interface RefUnwrapBailTypes {
 *     runtimeDOMBailTypes: Node | Window
 *   }
 * }
 * ```
 */
export interface RefUnwrapBailTypes {}

export type ShallowUnwrapRef<T> = {
  [K in keyof T]: T[K] extends Ref<infer V>
    ? V // if `V` is `unknown` that means it does not extend `Ref` and is undefined
    : T[K] extends Ref<infer V> | undefined
      ? unknown extends V
        ? undefined
        : V | undefined
      : T[K]
}

export type UnwrapRef<T> = T extends ShallowRef<infer V>
  ? V
  : T extends Ref<infer V>
    ? UnwrapRefSimple<V>
    : UnwrapRefSimple<T>

export type UnwrapRefSimple<T> = T extends
  | Function
  | BaseTypes
  | Ref
  | RefUnwrapBailTypes[keyof RefUnwrapBailTypes]
  | { [RawSymbol]?: true }
  ? T
  : T extends Map<infer K, infer V>
    ? Map<K, UnwrapRefSimple<V>>
    : T extends WeakMap<infer K, infer V>
      ? WeakMap<K, UnwrapRefSimple<V>>
      : T extends Set<infer V>
        ? Set<UnwrapRefSimple<V>>
        : T extends WeakSet<infer V>
          ? WeakSet<UnwrapRefSimple<V>>
          : T extends ReadonlyArray<any>
            ? { [K in keyof T]: UnwrapRefSimple<T[K]> }
            : T extends object & { [ShallowReactiveMarker]?: never }
              ? {
                  [P in keyof T]: P extends symbol ? T[P] : UnwrapRef<T[P]>
                }
              : T
