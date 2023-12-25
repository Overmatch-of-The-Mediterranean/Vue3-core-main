import {
  camelize,
  EMPTY_OBJ,
  toHandlerKey,
  extend,
  hasOwn,
  hyphenate,
  isArray,
  isFunction,
  isObject,
  isString,
  isOn,
  UnionToIntersection,
  looseToNumber
} from '@vue/shared'
import {
  ComponentInternalInstance,
  ComponentOptions,
  ConcreteComponent,
  formatComponentName
} from './component'
import { callWithAsyncErrorHandling, ErrorCodes } from './errorHandling'
import { warn } from './warning'
import { devtoolsComponentEmit } from './devtools'
import { AppContext } from './apiCreateApp'
import { emit as compatInstanceEmit } from './compat/instanceEventEmitter'
import {
  compatModelEventPrefix,
  compatModelEmit
} from './compat/componentVModel'

export type ObjectEmitsOptions = Record<
  string,
  ((...args: any[]) => any) | null
>

export type EmitsOptions = ObjectEmitsOptions | string[]

export type EmitsToProps<T extends EmitsOptions> = T extends string[]
  ? {
      [K in string & `on${Capitalize<T[number]>}`]?: (...args: any[]) => any
    }
  : T extends ObjectEmitsOptions
    ? {
        [K in string &
          `on${Capitalize<string & keyof T>}`]?: K extends `on${infer C}`
          ? T[Uncapitalize<C>] extends null
            ? (...args: any[]) => any
            : (
                ...args: T[Uncapitalize<C>] extends (...args: infer P) => any
                  ? P
                  : never
              ) => any
          : never
      }
    : {}

export type EmitFn<
  Options = ObjectEmitsOptions,
  Event extends keyof Options = keyof Options
> = Options extends Array<infer V>
  ? (event: V, ...args: any[]) => void
  : {} extends Options // if the emit is empty object (usually the default value for emit) should be converted to function
    ? (event: string, ...args: any[]) => void
    : UnionToIntersection<
        {
          [key in Event]: Options[key] extends (...args: infer Args) => any
            ? (event: key, ...args: Args) => void
            : (event: key, ...args: any[]) => void
        }[Event]
      >

/**
 * 主要做了两件事：
 * 1.检查触发的事件是否已经在组件内被定义或者是否满足定义的要求
 * 2.对组件上使用v-model背后的:modelxxx，@update:xxx及其修饰符的处理
 */
export function emit(
  instance: ComponentInternalInstance,
  event: string,
  ...rawArgs: any[]
) {
  if (instance.isUnmounted) return

  const props = instance.vnode.props || EMPTY_OBJ

  if (__DEV__) {
    // 获取标准化后的emits和props
    const {
      emitsOptions,
      propsOptions: [propsOptions]
    } = instance
    if (emitsOptions) {
      // 警告用户调用了emit，但却没有在emitsOptions中找到，说明组件内没有定义
      if (
        !(event in emitsOptions) &&
        !(
          __COMPAT__ &&
          (event.startsWith('hook:') ||
            event.startsWith(compatModelEventPrefix))
        )
      ) {
        if (!propsOptions || !(toHandlerKey(event) in propsOptions)) {
          warn(
            `Component emitted event "${event}" but it is neither declared in ` +
              `the emits option nor as an "${toHandlerKey(event)}" prop.`
          )
        }
      }
      // 获取此事件的验证函数
      else {
        const validator = emitsOptions[event]
        if (isFunction(validator)) {
          // 验证事件是否满足定义
          const isValid = validator(...rawArgs)
          if (!isValid) {
            warn(
              `Invalid event arguments: event validation failed for event "${event}".`
            )
          }
        }
      }
    }
  }

  let args = rawArgs

  // 在组件上使用v-model，本质上是:modelValue 和 @update:modelValue的语法糖
  // 这里就是对组件上使用v-model及其修饰符的处理
  // 判断是否是组件上的v-model
  const isModelListener = event.startsWith('update:')

  // for v-model update:xxx events, apply modifiers on args
  const modelArg = isModelListener && event.slice(7) // 截取的value
  /*
    使用v-model的组件内部
    props: ['modelValue'],
    emits: ['update:modelValue']
  */
  if (modelArg && modelArg in props) {
    // v-model 对应 :modelValue 和 @update:modelValue
    // v-model:title 对应 :title 和 @update:title
    // 这里是对默认和自定义情况的处理
    const modifiersKey = `${
      modelArg === 'modelValue' ? 'model' : modelArg
    }Modifiers`

    // 对v-model使用修饰符的处理
    // trim, number, once
    const { number, trim } = props[modifiersKey] || EMPTY_OBJ
    if (trim) {
      args = rawArgs.map(a => (isString(a) ? a.trim() : a))
    }
    if (number) {
      args = rawArgs.map(looseToNumber)
    }
  }

  if (__DEV__ || __FEATURE_PROD_DEVTOOLS__) {
    devtoolsComponentEmit(instance, event, args)
  }

  if (__DEV__) {
    const lowerCaseEvent = event.toLowerCase()
    if (lowerCaseEvent !== event && props[toHandlerKey(lowerCaseEvent)]) {
      warn(
        `Event "${lowerCaseEvent}" is emitted in component ` +
          `${formatComponentName(
            instance,
            instance.type
          )} but the handler is registered for "${event}". ` +
          `Note that HTML attributes are case-insensitive and you cannot use ` +
          `v-on to listen to camelCase events when using in-DOM templates. ` +
          `You should probably use "${hyphenate(event)}" instead of "${event}".`
      )
    }
  }

  let handlerName
  // 对事件名称进行改造，改造成props中的命名规范
  // 改造去查找有没有改事件对应的处理函数
  let handler =
    props[(handlerName = toHandlerKey(event))] ||
    // also try camelCase event handler (#2249)
    props[(handlerName = toHandlerKey(camelize(event)))]

  // for v-model update:xxx events, also trigger kebab-case equivalent
  // for props passed via kebab-case
  // 没有该事件对应的处理函数，并且是组件上使用v-model的情况
  if (!handler && isModelListener) {
    handler = props[(handlerName = toHandlerKey(hyphenate(event)))]
  }

  // 如果事件处理函数存在，则执行
  if (handler) {
    callWithAsyncErrorHandling(
      handler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  // 如果有once事件，且没有执行过，则存入emitted并执行。
  // emitted中属性为true，意味着该事件只执行一次，并且已经执行过了，以后不会再执行
  const onceHandler = props[handlerName + `Once`]
  if (onceHandler) {
    if (!instance.emitted) {
      instance.emitted = {}
    }
    // 已经执行过一次了，以后不会再执行
    else if (instance.emitted[handlerName]) {
      return
    }
    // once事件还没有执行一次，将其执行一次并标记为true
    instance.emitted[handlerName] = true
    callWithAsyncErrorHandling(
      onceHandler,
      instance,
      ErrorCodes.COMPONENT_EVENT_HANDLER,
      args
    )
  }

  if (__COMPAT__) {
    compatModelEmit(instance, event, args)
    return compatInstanceEmit(instance, event, args)
  }
}

// 对组件内的emits进行标准化，无论什么形式都标准化为emits:{}
// 例如emits:['foo'] ===> emits:{ foo: null }
export function normalizeEmitsOptions(
  comp: ConcreteComponent,
  appContext: AppContext,
  asMixin = false
): ObjectEmitsOptions | null {
  // 先检查缓存
  const cache = appContext.emitsCache
  const cached = cache.get(comp)
  if (cached !== undefined) {
    return cached
  }

  // 取出组件内的emits
  const raw = comp.emits

  // 标准化后的emits，也是该函数的返回值
  let normalized: ObjectEmitsOptions = {}

  // apply mixin/extends emits
  // 合并mixins与extends中emits
  // mixins和extends实现上没有什么区别，只是mixins可以是数组，extends只能是对象
  let hasExtends = false
  if (__FEATURE_OPTIONS_API__ && !isFunction(comp)) {
    // 因为mixins和extends里面还可以写mixins和extends，所以需要递归调用normalizeEmitsOptions进行标准化
    /*  例如
        const mixins = [
            {
                extend:{},
                mixins:[{props}],
                props
            }
        ]
    */
    const extendEmits = (raw: ComponentOptions) => {
      const normalizedFromExtend = normalizeEmitsOptions(raw, appContext, true)
      if (normalizedFromExtend) {
        hasExtends = true
        extend(normalized, normalizedFromExtend)
      }
    }
    // asMixin确保多次调用normalizeEmitsOptions全局mixins只会进行一次合并，因为全局mixins也只需要被合并一次
    if (!asMixin && appContext.mixins.length) {
      appContext.mixins.forEach(extendEmits)
    }

    // 先合并全局的mixins，再合并组件自己的mixins
    // 因为合并本质上用的是Object.assign函数，所以对于相同的属性，后合并的会覆盖之前的值
    // 这也就是为什么组件内的mixins的优先级更高
    if (comp.extends) {
      extendEmits(comp.extends)
    }
    if (comp.mixins) {
      comp.mixins.forEach(extendEmits)
    }
  }

  // 如果组件内部没有emits且没有继承，缓存设置为null
  if (!raw && !hasExtends) {
    if (isObject(comp)) {
      cache.set(comp, null)
    }
    return null
  }

  // emits:['foo', 'bar] === >emits:{ foo:null, bar:null }
  if (isArray(raw)) {
    raw.forEach(key => (normalized[key] = null))
  } else {
    extend(normalized, raw)
  }

  // 如果是有状态组件，则设置缓存
  if (isObject(comp)) {
    cache.set(comp, normalized)
  }
  return normalized
}

//检查传入的属性键是否是声明的emit事件监听器。
//例如:使用' emit: {click: null} '，名为' onClick '和' onclick '的属性名都被认为是匹配的监听器
export function isEmitListener(
  options: ObjectEmitsOptions | null,
  key: string
): boolean {
  if (!options || !isOn(key)) {
    return false
  }

  if (__COMPAT__ && key.startsWith(compatModelEventPrefix)) {
    return true
  }

  key = key.slice(2).replace(/Once$/, '')
  return (
    hasOwn(options, key[0].toLowerCase() + key.slice(1)) ||
    hasOwn(options, hyphenate(key)) ||
    hasOwn(options, key)
  )
}
