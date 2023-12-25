import { hyphenate, isArray } from '@vue/shared'
import {
  ErrorCodes,
  ComponentInternalInstance,
  callWithAsyncErrorHandling
} from '@vue/runtime-core'

interface Invoker extends EventListener {
  value: EventValue
  attached: number
}

type EventValue = Function | Function[]

// 添加事件监听
export function addEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.addEventListener(event, handler, options)
}
// 移除事件监听
export function removeEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.removeEventListener(event, handler, options)
}

const veiKey = Symbol('_vei')

export function patchEvent(
  el: Element & { [veiKey]?: Record<string, Invoker | undefined> },
  rawName: string,
  prevValue: EventValue | null,
  nextValue: EventValue | null,
  instance: ComponentInternalInstance | null = null
) {
  // vei = vue event invokers
  // 因为一个DOM元素可以绑定多个事件，因此invokers存储多种事件的invoker
  const invokers = el[veiKey] || (el[veiKey] = {})
  const existingInvoker = invokers[rawName]

  if (nextValue && existingInvoker) {
    // 事件更新，使用伪造的事件处理函数invoker，减少removeEventListener，提升性能
    // patch
    existingInvoker.value = nextValue
  } else {
    const [name, options] = parseName(rawName)
    if (nextValue) {
      // add
      // 此种事件不存在invoker，处理出事件名，并为其生成invoker，并绑定
      const invoker = (invokers[rawName] = createInvoker(nextValue, instance))
      addEventListener(el, name, invoker, options)
    } else if (existingInvoker) {
      // remove
      // 移除事件
      removeEventListener(el, name, existingInvoker, options)
      invokers[rawName] = undefined
    }
  }
}

const optionsModifierRE = /(?:Once|Passive|Capture)$/
// 解析事件名
function parseName(name: string): [string, EventListenerOptions | undefined] {
  let options: EventListenerOptions | undefined
  if (optionsModifierRE.test(name)) {
    options = {}
    let m
    while ((m = name.match(optionsModifierRE))) {
      name = name.slice(0, name.length - m[0].length)
      ;(options as any)[m[0].toLowerCase()] = true
    }
  }
  const event = name[2] === ':' ? name.slice(3) : hyphenate(name.slice(2))
  return [event, options]
}

// To avoid the overhead of repeatedly calling Date.now(), we cache
// and use the same timestamp for all event listeners attached in the same tick.
let cachedNow: number = 0
const p = /*#__PURE__*/ Promise.resolve()
const getNow = () =>
  cachedNow || (p.then(() => (cachedNow = 0)), (cachedNow = Date.now()))

function createInvoker(
  initialValue: EventValue,
  instance: ComponentInternalInstance | null
) {
  const invoker: Invoker = (e: Event & { _vts?: number }) => {
    // async edge case vuejs/vue#6566
    // inner click event triggers patch, event handler
    // attached to outer element during patch, and triggered again. This
    // happens because browsers fire microtask ticks between event propagation.
    // this no longer happens for templates in Vue 3, but could still be
    // theoretically possible for hand-written render functions.
    // the solution: we save the timestamp when a handler is attached,
    // and also attach the timestamp to any event that was handled by vue
    // for the first time (to avoid inconsistent event timestamp implementations
    // or events fired from iframes, e.g. #2513)
    // The handler would only fire if the event passed to it was fired
    // AFTER it was attached.
    if (!e._vts) {
      e._vts = Date.now() // 事件触发的时间
    }
    // 避免绑定时间晚于事件触发时间的事件处理函数的执行
    else if (e._vts <= invoker.attached) {
      return
    }
    callWithAsyncErrorHandling(
      // 真正的事件处理函数在这个函数里面执行
      patchStopImmediatePropagation(e, invoker.value),
      instance,
      ErrorCodes.NATIVE_EVENT_HANDLER,
      [e]
    )
  }
  // 事件处理函数
  invoker.value = initialValue
  // 绑定事件处理函数的时间
  invoker.attached = getNow()
  return invoker
}

// 停止冒泡
function patchStopImmediatePropagation(
  e: Event,
  value: EventValue
): EventValue {
  // 一个事件对应多个事件处理函数
  if (isArray(value)) {
    /*
        如果多个事件监听器被附加到相同元素的相同事件类型上，当此事件触发时，它们会按其被添加的顺序被调用。
        如果在其中一个事件监听器中执行 stopImmediatePropagation() ，那么剩下的事件监听器都不会被调用。
    */
    const originalStop = e.stopImmediatePropagation
    e.stopImmediatePropagation = () => {
      originalStop.call(e)
      ;(e as any)._stopped = true
    }
    // 遍历每个事件处理函数执行
    return value.map(fn => (e: Event) => !(e as any)._stopped && fn && fn(e))
  }
  // 事件处理函数只有一个的情况
  else {
    return value
  }
}
