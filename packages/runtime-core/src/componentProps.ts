import {
  toRaw,
  shallowReactive,
  trigger,
  TriggerOpTypes
} from '@vue/reactivity'
import {
  EMPTY_OBJ,
  camelize,
  hyphenate,
  capitalize,
  isString,
  isFunction,
  isArray,
  isObject,
  hasOwn,
  toRawType,
  PatchFlags,
  makeMap,
  isReservedProp,
  EMPTY_ARR,
  def,
  extend,
  isOn,
  IfAny
} from '@vue/shared'
import { warn } from './warning'
import {
  Data,
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  setCurrentInstance,
  unsetCurrentInstance
} from './component'
import { isEmitListener } from './componentEmits'
import { InternalObjectKey } from './vnode'
import { AppContext } from './apiCreateApp'
import { createPropsDefaultThis } from './compat/props'
import { isCompatEnabled, softAssertCompatEnabled } from './compat/compatConfig'
import { DeprecationTypes } from './compat/compatConfig'
import { shouldSkipAttr } from './compat/attrsFallthrough'

export type ComponentPropsOptions<P = Data> =
  | ComponentObjectPropsOptions<P>
  | string[]

export type ComponentObjectPropsOptions<P = Data> = {
  [K in keyof P]: Prop<P[K]> | null
}

export type Prop<T, D = T> = PropOptions<T, D> | PropType<T>

type DefaultFactory<T> = (props: Data) => T | null | undefined

export interface PropOptions<T = any, D = T> {
  type?: PropType<T> | true | null
  required?: boolean
  default?: D | DefaultFactory<D> | null | undefined | object
  validator?(value: unknown): boolean
  /**
   * @internal
   */
  skipCheck?: boolean
  /**
   * @internal
   */
  skipFactory?: boolean
}

export type PropType<T> = PropConstructor<T> | PropConstructor<T>[]

type PropConstructor<T = any> =
  | { new (...args: any[]): T & {} }
  | { (): T }
  | PropMethod<T>

type PropMethod<T, TConstructor = any> = [T] extends [
  ((...args: any) => any) | undefined
] // if is function with args, allowing non-required functions
  ? { new (): TConstructor; (): T; readonly prototype: TConstructor } // Create Function like constructor
  : never

type RequiredKeys<T> = {
  [K in keyof T]: T[K] extends
    | { required: true }
    | { default: any }
    // don't mark Boolean props as undefined
    | BooleanConstructor
    | { type: BooleanConstructor }
    ? T[K] extends { default: undefined | (() => undefined) }
      ? never
      : K
    : never
}[keyof T]

type OptionalKeys<T> = Exclude<keyof T, RequiredKeys<T>>

type DefaultKeys<T> = {
  [K in keyof T]: T[K] extends
    | { default: any }
    // Boolean implicitly defaults to false
    | BooleanConstructor
    | { type: BooleanConstructor }
    ? T[K] extends { type: BooleanConstructor; required: true } // not default if Boolean is marked as required
      ? never
      : K
    : never
}[keyof T]

type InferPropType<T> = [T] extends [null]
  ? any // null & true would fail to infer
  : [T] extends [{ type: null | true }]
    ? any // As TS issue https://github.com/Microsoft/TypeScript/issues/14829 // somehow `ObjectConstructor` when inferred from { (): T } becomes `any` // `BooleanConstructor` when inferred from PropConstructor(with PropMethod) becomes `Boolean`
    : [T] extends [ObjectConstructor | { type: ObjectConstructor }]
      ? Record<string, any>
      : [T] extends [BooleanConstructor | { type: BooleanConstructor }]
        ? boolean
        : [T] extends [DateConstructor | { type: DateConstructor }]
          ? Date
          : [T] extends [(infer U)[] | { type: (infer U)[] }]
            ? U extends DateConstructor
              ? Date | InferPropType<U>
              : InferPropType<U>
            : [T] extends [Prop<infer V, infer D>]
              ? unknown extends V
                ? IfAny<V, V, D>
                : V
              : T

/**
 * Extract prop types from a runtime props options object.
 * The extracted types are **internal** - i.e. the resolved props received by
 * the component.
 * - Boolean props are always present
 * - Props with default values are always present
 *
 * To extract accepted props from the parent, use {@link ExtractPublicPropTypes}.
 */
export type ExtractPropTypes<O> = {
  // use `keyof Pick<O, RequiredKeys<O>>` instead of `RequiredKeys<O>` to
  // support IDE features
  [K in keyof Pick<O, RequiredKeys<O>>]: InferPropType<O[K]>
} & {
  // use `keyof Pick<O, OptionalKeys<O>>` instead of `OptionalKeys<O>` to
  // support IDE features
  [K in keyof Pick<O, OptionalKeys<O>>]?: InferPropType<O[K]>
}

type PublicRequiredKeys<T> = {
  [K in keyof T]: T[K] extends { required: true } ? K : never
}[keyof T]

type PublicOptionalKeys<T> = Exclude<keyof T, PublicRequiredKeys<T>>

/**
 * Extract prop types from a runtime props options object.
 * The extracted types are **public** - i.e. the expected props that can be
 * passed to component.
 */
export type ExtractPublicPropTypes<O> = {
  [K in keyof Pick<O, PublicRequiredKeys<O>>]: InferPropType<O[K]>
} & {
  [K in keyof Pick<O, PublicOptionalKeys<O>>]?: InferPropType<O[K]>
}

const enum BooleanFlags {
  shouldCast,
  shouldCastTrue
}

// extract props which defined with default from prop options
export type ExtractDefaultPropTypes<O> = O extends object
  ? // use `keyof Pick<O, DefaultKeys<O>>` instead of `DefaultKeys<O>` to support IDE features
    { [K in keyof Pick<O, DefaultKeys<O>>]: InferPropType<O[K]> }
  : {}

type NormalizedProp =
  | null
  | (PropOptions & {
      [BooleanFlags.shouldCast]?: boolean
      [BooleanFlags.shouldCastTrue]?: boolean
    })

// normalized value is a tuple of the actual normalized options
// and an array of prop keys that need value casting (booleans and defaults)
export type NormalizedProps = Record<string, NormalizedProp>
export type NormalizedPropsOptions = [NormalizedProps, string[]] | []

// 解析子组件的props和attrs数据
export function initProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null, // vnode.props，传递给组件的数据
  isStateful: number, // result of bitwise flag comparison
  isSSR = false
) {
  const props: Data = {}
  const attrs: Data = {}
  def(attrs, InternalObjectKey, 1)

  instance.propsDefaults = Object.create(null)

  // 使用传递的数据rawProps将props和attrs处理出来
  setFullProps(instance, rawProps, props, attrs)

  // ensure all declared prop keys are present
  // 遍历normalized
  for (const key in instance.propsOptions[0]) {
    if (!(key in props)) {
      props[key] = undefined
    }
  }

  // validation
  if (__DEV__) {
    validateProps(rawProps || {}, props, instance)
  }

  // 将props和attrs赋值给组件实例
  if (isStateful) {
    // stateful
    instance.props = isSSR ? props : shallowReactive(props)
  } else {
    if (!instance.type.props) {
      // functional w/ optional props, props === attrs
      instance.props = attrs
    } else {
      // functional w/ declared props
      instance.props = props
    }
  }
  instance.attrs = attrs
}

function isInHmrContext(instance: ComponentInternalInstance | null) {
  while (instance) {
    if (instance.type.__hmrId) return true
    instance = instance.parent
  }
}

// 更新组件props
export function updateProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  rawPrevProps: Data | null,
  optimized: boolean
) {
  const {
    props,
    attrs,
    vnode: { patchFlag }
  } = instance
  const rawCurrentProps = toRaw(props)
  const [options] = instance.propsOptions
  let hasAttrsChanged = false

  if (
    // always force full diff in dev
    // - #1942 if hmr is enabled with sfc component
    // - vite#872 non-sfc component used by sfc component
    !(__DEV__ && isInHmrContext(instance)) &&
    (optimized || patchFlag > 0) &&
    !(patchFlag & PatchFlags.FULL_PROPS)
  ) {
    if (patchFlag & PatchFlags.PROPS) {
      // Compiler-generated props & no keys change, just set the updated
      // the props.
      const propsToUpdate = instance.vnode.dynamicProps!
      for (let i = 0; i < propsToUpdate.length; i++) {
        let key = propsToUpdate[i]
        // skip if the prop key is a declared emit event listener
        if (isEmitListener(instance.emitsOptions, key)) {
          continue
        }
        // PROPS flag guarantees rawProps to be non-null
        const value = rawProps![key]
        if (options) {
          // attr / props separation was done on init and will be consistent
          // in this code path, so just check if attrs have it.
          if (hasOwn(attrs, key)) {
            if (value !== attrs[key]) {
              attrs[key] = value
              hasAttrsChanged = true
            }
          } else {
            const camelizedKey = camelize(key)
            props[camelizedKey] = resolvePropValue(
              options,
              rawCurrentProps,
              camelizedKey,
              value,
              instance,
              false /* isAbsent */
            )
          }
        } else {
          if (__COMPAT__) {
            if (isOn(key) && key.endsWith('Native')) {
              key = key.slice(0, -6) // remove Native postfix
            } else if (shouldSkipAttr(key, instance)) {
              continue
            }
          }
          if (value !== attrs[key]) {
            attrs[key] = value
            hasAttrsChanged = true
          }
        }
      }
    }
  } else {
    // full props update.
    if (setFullProps(instance, rawProps, props, attrs)) {
      hasAttrsChanged = true
    }
    // in case of dynamic props, check if we need to delete keys from
    // the props object
    let kebabKey: string
    for (const key in rawCurrentProps) {
      if (
        !rawProps ||
        // for camelCase
        (!hasOwn(rawProps, key) &&
          // it's possible the original props was passed in as kebab-case
          // and converted to camelCase (#955)
          ((kebabKey = hyphenate(key)) === key || !hasOwn(rawProps, kebabKey)))
      ) {
        if (options) {
          if (
            rawPrevProps &&
            // for camelCase
            (rawPrevProps[key] !== undefined ||
              // for kebab-case
              rawPrevProps[kebabKey!] !== undefined)
          ) {
            props[key] = resolvePropValue(
              options,
              rawCurrentProps,
              key,
              undefined,
              instance,
              true /* isAbsent */
            )
          }
        } else {
          delete props[key]
        }
      }
    }
    // in the case of functional component w/o props declaration, props and
    // attrs point to the same object so it should already have been updated.
    if (attrs !== rawCurrentProps) {
      for (const key in attrs) {
        if (
          !rawProps ||
          (!hasOwn(rawProps, key) &&
            (!__COMPAT__ || !hasOwn(rawProps, key + 'Native')))
        ) {
          delete attrs[key]
          hasAttrsChanged = true
        }
      }
    }
  }

  // trigger updates for $attrs in case it's used in component slots
  if (hasAttrsChanged) {
    trigger(instance, TriggerOpTypes.SET, '$attrs')
  }

  if (__DEV__) {
    validateProps(rawProps || {}, props, instance)
  }
}

/*
    props的处理分为两步：
    1.对不含default属性的处理
    2.对含default属性的处理
*/
function setFullProps(
  instance: ComponentInternalInstance,
  rawProps: Data | null,
  props: Data,
  attrs: Data
) {
  // 标准化后的参数
  // options就是normalizePropsOptions执行后产生的normalized
  /*
    needCastKeys，这个代表的是需要特殊处理的key，例如:props:{msg:{default:"msg"}}含有default，
    那么理论上我们应当判断传递的属性值是否存在，然后在决定是否使用default的值，
    但是这里我们仅进行标准化，所以对于含有default属性以及是Boolean类型的我们需要单独放入needCastKeys中，便于后面对props中的处理。

  */
  const [options, needCastKeys] = instance.propsOptions
  let hasAttrsChanged = false

  // 如果是需要特殊处理的key(含有defalut或类型为Boolean)，获取它的值放入rawCastValues当中
  let rawCastValues: Data | undefined
  // 遍历父组件传递的数据
  if (rawProps) {
    for (let key in rawProps) {
      // key, ref are reserved and never passed down
      // 一些保留的属性不会被传递，例如key，ref
      if (isReservedProp(key)) {
        continue
      }

      if (__COMPAT__) {
        if (key.startsWith('onHook:')) {
          softAssertCompatEnabled(
            DeprecationTypes.INSTANCE_EVENT_HOOKS,
            instance,
            key.slice(2).toLowerCase()
          )
        }
        if (key === 'inline-template') {
          continue
        }
      }

      const value = rawProps[key]

      // prop选项名在规范化过程中是驼峰化的，所以要支持
      // kebab ->驼峰转换这里我们需要将键驼峰化。
      let camelKey
      if (options && hasOwn(options, (camelKey = camelize(key)))) {
        // 该属性不含有defalut，将父组件传递给它的值以键值对形式存入props中
        if (!needCastKeys || !needCastKeys.includes(camelKey)) {
          props[camelKey] = value
        }
        // props:{"msg":{default:"a"}}
        // 含有defalut的属性，将父组件传递给它的值以键值对形式存入rawCastValues中
        else {
          ;(rawCastValues || (rawCastValues = {}))[camelKey] = value
        }
      }
      // 判断key是否是自定义事件
      else if (!isEmitListener(instance.emitsOptions, key)) {
        // Any non-declared (either as a prop or an emitted event) props are put
        // into a separate `attrs` object for spreading. Make sure to preserve
        // original key casing
        if (__COMPAT__) {
          if (isOn(key) && key.endsWith('Native')) {
            key = key.slice(0, -6) // remove Native postfix
          } else if (shouldSkipAttr(key, instance)) {
            continue
          }
        }
        // 为组件传递props时，哪些没有显式声明为props的数据
        // 并且也不是自定义事件会被存放到attrs对象中
        if (!(key in attrs) || value !== attrs[key]) {
          attrs[key] = value
          hasAttrsChanged = true
        }
      }
    }
  }
  // 对有defalut的属性的处理
  if (needCastKeys) {
    // 不含dafault的属性，对象键值对为key->父组件传递的值
    const rawCurrentProps = toRaw(props)
    // 含default的属性,，对象键值对为key->父组件传递的值
    const castValues = rawCastValues || EMPTY_OBJ
    for (let i = 0; i < needCastKeys.length; i++) {
      const key = needCastKeys[i]
      props[key] = resolvePropValue(
        options!, // normalized
        rawCurrentProps,
        key,
        castValues[key],
        instance,
        !hasOwn(castValues, key)
      )
    }
  }

  return hasAttrsChanged
}

// 解析props的值，对有默认值父组件没有传值以及prop是布尔类型的处理
function resolvePropValue(
  options: NormalizedProps,
  props: Data,
  key: string,
  value: unknown,
  instance: ComponentInternalInstance,
  isAbsent: boolean
) {
  // 取出子组件内部声明的props的属性对应的定义
  // opt = { type:xxx, default:xxx, ... }
  const opt = options[key]
  if (opt != null) {
    const hasDefault = hasOwn(opt, 'default')
    // 对默认值的处理
    if (hasDefault && value === undefined) {
      const defaultValue = opt.default
      // type不为函数，且默认值是函数类型的情况处理，针对对象，数组
      if (
        opt.type !== Function &&
        !opt.skipFactory &&
        isFunction(defaultValue)
      ) {
        const { propsDefaults } = instance
        if (key in propsDefaults) {
          value = propsDefaults[key]
        } else {
          setCurrentInstance(instance)
          value = propsDefaults[key] = defaultValue.call(
            __COMPAT__ &&
              isCompatEnabled(DeprecationTypes.PROPS_DEFAULT_THIS, instance)
              ? createPropsDefaultThis(instance, props, key)
              : null,
            props
          )
          unsetCurrentInstance()
        }
      } else {
        value = defaultValue
      }
    }
    // boolean casting
    // 对布尔类型数据的处理
    if (opt[BooleanFlags.shouldCast]) {
      if (isAbsent && !hasDefault) {
        // 父组件没有给该布尔类型传值，且无默认值，则value设置为false
        value = false
      } else if (
        // 不是含String类型或Boolean在String的前面
        opt[BooleanFlags.shouldCastTrue] &&
        (value === '' || value === hyphenate(key))
      ) {
        value = true
      }
    }
  }
  return value
}

// 对props进行标准化，无论props是什么格式，例如数组props:['name', 'nick-name']，将props中属性统一转化为key:{...}的形式
// 此函数就是处理子组件中props，将键转化为驼峰形式
// 并且使用needCastKeys存放有default或者是Boolean类型的属性
// 将props中属性统一转化为key:{...}的形式，存放在normalized中
export function normalizePropsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): NormalizedPropsOptions {
  // 是否有之前处理好的缓存，如果有直接返回
  const cache = appContext.propsCache
  const cached = cache.get(comp)
  if (cached) {
    return cached
  }

  const raw = comp.props
  // normalized表示合并了mixins和extends后的props
  const normalized: NormalizedPropsOptions[0] = {}

  /*
    needCastKeys，这个代表的是需要特殊处理的key，例如:props:{msg:{default:"msg"}}含有default，
    那么理论上我们应当判断传递的属性值是否存在，然后在决定是否使用default的值，
    但是这里我们仅进行标准化，所以对于含有default属性以及是Boolean类型的我们需要单独放入needCastKeys中，便于后面对props中的处理。
  */
  const needCastKeys: NormalizedPropsOptions[1] = []

  // 合并mixins和extends中的props
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    // 因为mixins和extends里面还可以写mixins和extends，所以需要递归调用normalizePropsOptions进行标准化
    /*  例如
        const mixins = [
            {
                extend:{},
                mixins:[{props}],
                props
            }
        ]
    */
    // 用来合并props的方法
    const extendProps = (raw: ComponentOptions) => {
      if (__COMPAT__ && isFunction(raw)) {
        raw = raw.options
      }
      hasExtends = true
      const [props, keys] = normalizePropsOptions(raw, appContext, true)
      extend(normalized, props)
      if (keys) needCastKeys.push(...keys)
    }
    // asMixin确保多次调用normalizePropsOptions全局mixins只会进行一次合并，因为全局mixins也只需要被合并一次
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendProps)
    }
    // 先合并全局的mixins，再合并组件自己的mixins
    // 因为合并本质上用的是Object.assign函数，所以对于相同的属性，后合并的会覆盖之前的值
    // 这也就是为什么组件内的mixins的优先级更高
    if (comp.extends) {
      extendProps(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendProps)
    }
  }

  // 子组件内部没有声明props
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, EMPTY_ARR as any)
    }
    return EMPTY_ARR as any
  }

  if (isArray(raw)) {
    // 对数组形式定义的props的处理，如props:['name', 'nick-name']
    /*
    处理完之后变为props:{
        name:{},
        nickName:{}
    }
  */
    for (let i = 0; i < raw.length; i++) {
      if (__DEV__ && !isString(raw[i])) {
        warn(`props must be strings when using array syntax.`, raw[i])
      }
      // 将每个键驼峰化
      const normalizedKey = camelize(raw[i])

      if (validatePropName(normalizedKey)) {
        // 将其变为props:{"name":{}, nickName:{}}
        normalized[normalizedKey] = EMPTY_OBJ
      }
    }
  }
  // 这里的raw代表子组件中定义的props
  else if (raw) {
    // props只能是数组和对象形式，否则是无效的props定义，报警告
    if (__DEV__ && !isObject(raw)) {
      warn(`invalid props options`, raw)
    }
    for (const key in raw) {
      const normalizedKey = camelize(key)
      if (validatePropName(normalizedKey)) {
        // 取出子组件内部声明的props的属性对应的定义
        // opt = { type:xxx, default:xxx, ... }
        const opt = raw[key]
        // 标准化
        const prop: NormalizedProp = (normalized[normalizedKey] =
          isArray(opt) || isFunction(opt) ? { type: opt } : extend({}, opt))
        if (prop) {
          // 找到Boolean类型在prop.type中的位置
          const booleanIndex = getTypeIndex(Boolean, prop.type)
          // 找到String类型在prop.type中的位置
          const stringIndex = getTypeIndex(String, prop.type)
          // 判断prop.type中是否有Boolean类型
          prop[BooleanFlags.shouldCast] = booleanIndex > -1
          // 判断prop.type中是否有String类型 或者 Boolean是否在String的前面
          // props.type:[Boolean, String]
          prop[BooleanFlags.shouldCastTrue] =
            stringIndex < 0 || booleanIndex < stringIndex
          /*
            再比如说<Comp yes></Comp>传递了yes属性，在propsOptions中props:{yes:{type:Boolean}}这样的key=>"yes"也是需要处理的，
            yes的值应该为true，所以对于type中含有Boolean的也需要放入needCastKeys中
          */
          // prop是Boolean类型 或者 prop含有default，则说明其需要特殊处理，要放入needCastKeys中
          if (booleanIndex > -1 || hasOwn(prop, 'default')) {
            needCastKeys.push(normalizedKey)
          }
        }
      }
    }
  }

  // 缓存起来
  const res: NormalizedPropsOptions = [normalized, needCastKeys]
  if (isObject(comp)) {
    cache.set(comp, res)
  }
  return res
}

// 传递的属性值不能以$开头，这是不合法的
function validatePropName(key: string) {
  if (key[0] !== '$') {
    return true
  } else if (__DEV__) {
    warn(`Invalid prop name: "${key}" is a reserved property.`)
  }
  return false
}

// use function string name to check type constructors
// so that it works across vms / iframes.
function getType(ctor: Prop<any>): string {
  const match = ctor && ctor.toString().match(/^\s*(function|class) (\w+)/)
  return match ? match[2] : ctor === null ? 'null' : ''
}

function isSameType(a: Prop<any>, b: Prop<any>): boolean {
  return getType(a) === getType(b)
}

function getTypeIndex(
  type: Prop<any>,
  expectedTypes: PropType<any> | void | null | true
): number {
  if (isArray(expectedTypes)) {
    return expectedTypes.findIndex(t => isSameType(t, type))
  } else if (isFunction(expectedTypes)) {
    return isSameType(expectedTypes, type) ? 0 : -1
  }
  return -1
}

/**
 * dev only
 */
// 对传递的props值进行校验
function validateProps(
  rawProps: Data, // vnode.props，传递给组件的数据
  props: Data, // 处理好的props数据
  instance: ComponentInternalInstance
) {
  const resolvedValues = toRaw(props)
  // 获取标准化后的props
  const options = instance.propsOptions[0]
  for (const key in options) {
    // opt是 { type:xxx, defalut:xxx, ....}
    let opt = options[key]
    // 如果类型为空，则该属性不需要校验
    if (opt == null) continue
    validateProp(
      key, // 属性名
      resolvedValues[key], // 传递的属性值
      opt, // 属性值得类型
      !hasOwn(rawProps, key) && !hasOwn(rawProps, hyphenate(key))
    )
  }
}

/**
 * dev only
 */
function validateProp(
  name: string,
  value: unknown,
  prop: PropOptions,
  isAbsent: boolean
) {
  // 组件中显示声明的props属性的规则
  const { type, required, validator, skipCheck } = prop

  // required!
  if (required && isAbsent) {
    warn('Missing required prop: "' + name + '"')
    return
  }
  // 没有传递值且不是必须的，直接返回结束该属性的校验
  if (value == null && !required) {
    return
  }
  // 检查传入的值类型是否符合声明规定
  if (type != null && type !== true && !skipCheck) {
    let isValid = false
    // 一个属性可能声明多个类型，所以将类型存为数组
    const types = isArray(type) ? type : [type]
    // 定义类型时期待的类型
    const expectedTypes = []
    // 遍历这些类型，依次对该值进行校验
    for (let i = 0; i < types.length && !isValid; i++) {
      // 真正进行校验的步骤，返回校验结果和期待的类型
      const { valid, expectedType } = assertType(value, types[i])
      expectedTypes.push(expectedType || '')
      isValid = valid
    }
    // 如果没有通过校验，说明传递的数据的类型不符合要求
    if (!isValid) {
      warn(getInvalidTypeMessage(name, value, expectedTypes))
      return
    }
  }

  // custom validator
  // 执行自定义的校验器
  if (validator && !validator(value)) {
    warn('Invalid prop: custom validator check failed for prop "' + name + '".')
  }
}

const isSimpleType = /*#__PURE__*/ makeMap(
  'String,Number,Boolean,Function,Symbol,BigInt'
)

type AssertionResult = {
  valid: boolean
  expectedType: string
}

/**
 * dev only
 */
// 真正进行校验的步骤，返回校验结果和期待的类型
function assertType(value: unknown, type: PropConstructor): AssertionResult {
  let valid
  // 得到要求的类型
  const expectedType = getType(type)
  // 检查是否是简单数据类型
  if (isSimpleType(expectedType)) {
    // 获取传递值的类型
    const t = typeof value
    // 传递值的类型是否符合预期的类型
    valid = t === expectedType.toLowerCase()
    // for primitive wrapper objects
    if (!valid && t === 'object') {
      valid = value instanceof type
    }
  }
  // 判断value是否是对象类型
  else if (expectedType === 'Object') {
    valid = isObject(value)
  }
  // 判断value是否是数组类型
  else if (expectedType === 'Array') {
    valid = isArray(value)
  }
  // 判断value是否是null
  else if (expectedType === 'null') {
    valid = value === null
  } else {
    valid = value instanceof type
  }
  // 返回校验结果和预期的类型信息
  return {
    valid,
    expectedType
  }
}

/**
 * dev only
 */
// 没有通过校验时，使用的报警告的函数
function getInvalidTypeMessage(
  name: string,
  value: unknown,
  expectedTypes: string[]
): string {
  if (expectedTypes.length === 0) {
    return (
      `Prop type [] for prop "${name}" won't match anything.` +
      ` Did you mean to use type Array instead?`
    )
  }
  let message =
    `Invalid prop: type check failed for prop "${name}".` +
    ` Expected ${expectedTypes.map(capitalize).join(' | ')}`
  const expectedType = expectedTypes[0]
  const receivedType = toRawType(value)
  const expectedValue = styleValue(value, expectedType)
  const receivedValue = styleValue(value, receivedType)
  // check if we need to specify expected value
  if (
    expectedTypes.length === 1 &&
    isExplicable(expectedType) &&
    !isBoolean(expectedType, receivedType)
  ) {
    message += ` with value ${expectedValue}`
  }
  message += `, got ${receivedType} `
  // check if we need to specify received value
  if (isExplicable(receivedType)) {
    message += `with value ${receivedValue}.`
  }
  return message
}

/**
 * dev only
 */
function styleValue(value: unknown, type: string): string {
  if (type === 'String') {
    return `"${value}"`
  } else if (type === 'Number') {
    return `${Number(value)}`
  } else {
    return `${value}`
  }
}

/**
 * dev only
 */
function isExplicable(type: string): boolean {
  const explicitTypes = ['string', 'number', 'boolean']
  return explicitTypes.some(elem => type.toLowerCase() === elem)
}

/**
 * dev only
 */
function isBoolean(...args: string[]): boolean {
  return args.some(elem => elem.toLowerCase() === 'boolean')
}
