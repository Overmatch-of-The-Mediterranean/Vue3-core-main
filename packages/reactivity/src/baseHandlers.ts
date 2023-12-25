import {
  reactive,
  readonly,
  toRaw,
  ReactiveFlags,
  Target,
  readonlyMap,
  reactiveMap,
  shallowReactiveMap,
  shallowReadonlyMap,
  isReadonly,
  isShallow
} from './reactive'
import { TrackOpTypes, TriggerOpTypes } from './operations'
import {
  track,
  trigger,
  ITERATE_KEY,
  pauseTracking,
  resetTracking
} from './effect'
import {
  isObject,
  hasOwn,
  isSymbol,
  hasChanged,
  isArray,
  isIntegerKey,
  makeMap
} from '@vue/shared'
import { isRef } from './ref'
import { warn } from './warning'

const isNonTrackableKeys = /*#__PURE__*/ makeMap(`__proto__,__v_isRef,__isVue`)

const builtInSymbols = new Set(
  /*#__PURE__*/
  Object.getOwnPropertyNames(Symbol)
    .filter(key => key !== 'arguments' && key !== 'caller')
    .map(key => (Symbol as any)[key])
    .filter(isSymbol)
)

const arrayInstrumentations = /*#__PURE__*/ createArrayInstrumentations()

// 对数组上的方法进行了重写，本质上就是在数组的原方法上再做一层封装
function createArrayInstrumentations() {
  const instrumentations: Record<string, Function> = {}
      
  // 对数组查找方法的重写，当使用代理对象调用相同的方法名时，就会返回对应重写后的方法   
  // p127, Reflect.get(instrumentations, key, receiver)
  ;(['includes', 'indexOf', 'lastIndexOf'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
        
      // 把代理对象转换成普原始数据
      const arr = toRaw(this) as any
      // 对数组的每个元素进行追踪
      for (let i = 0, l = this.length; i < l; i++) {
        track(arr, TrackOpTypes.GET, i + '')
      }
      
    
      // p124，然后跳到p128
      // 和p124有些区别，p124是数据不变，数组原生函数中的this改变，用同一个数据，在代理对象和普通数据中查找
      // 源码中是，原生函数中this固定为普通数组，使用数据的两种形态，分别在这个普通数组中查找
      
      // 将函数参数不做任何处理地直接传递给数组的原始方法，然后调用数组的原始方法
      // 因为arg可能是代理的数据或普通数据
      // 相当于用第一次查找排除是否是代理数据，所以先查找代理的数据是否在arr这个普通数组中
      const res = arr[key](...args)
        // 如果不在，则把arg转化成普通数据，再查找这个普通数据
        // 如果没有找到，可能参数中有响应对象，将参数转为原始对象，再调用方法
      if (res === -1 || res === false) {
        // 以防参数是响应式的，再执行一次
        return arr[key](...args.map(toRaw))
      } else {
        return res
      }
    }
  })

  // 重写隐式修改数组长度的原型方法
  ;(['push', 'pop', 'shift', 'unshift', 'splice'] as const).forEach(key => {
    instrumentations[key] = function (this: unknown[], ...args: unknown[]) {
      // p129~130, 解决这些方法的规范中既会访问length也会修改length这个特点所造成的栈溢出问题   
      // 在调用原始方法之前,禁止追踪
      pauseTracking()
      const res = (toRaw(this) as any)[key].apply(this, args)
      // 在调用原始方法之后,可以追踪
      resetTracking()
      return res
    }
  })
  return instrumentations
}

function hasOwnProperty(this: object, key: string) {
  const obj = toRaw(this)
  track(obj, TrackOpTypes.HAS, key)
  return obj.hasOwnProperty(key)
}

// 这个类只有get拦截器方法
class BaseReactiveHandler implements ProxyHandler<Target> {
  constructor(
    protected readonly _isReadonly = false,
    protected readonly _shallow = false
  ) {}

  get(target: Target, key: string | symbol, receiver: object) {
    
    const isReadonly = this._isReadonly,
      shallow = this._shallow
    // 下面112 ~ 143 用于标志位判断，如reactive.ts文件中(value as Target)[ReactiveFlags.IS_REACTIVE]
    // 代理对象通过访问这个标志位，判断该代理对象是否是由 reactive 创建的普通响应式代理
    if (key === ReactiveFlags.IS_REACTIVE) {
      return !isReadonly
    }
    // 代理对象通过访问这个标志位，判断该代理对象是否是只读的(是否由readonly创建的响应式代理)
    else if (key === ReactiveFlags.IS_READONLY) {
      return isReadonly
    }
    // 代理对象通过访问这个标志位，判断该代理对象是否是浅代理(是否由shallowReactive创建的响应式代理)
    else if (key === ReactiveFlags.IS_SHALLOW) {
      return shallow
    }
    // 只有使用get方法的对象是代理对象时，使用ReactiveFlags.RAW访问才能得到值
    else if (key === ReactiveFlags.RAW) { 
      if (
        receiver ===
          (isReadonly
            ? shallow
              ? shallowReadonlyMap
              : readonlyMap
            : shallow
              ? shallowReactiveMap
              : reactiveMap
          ).get(target) ||
        
        Object.getPrototypeOf(target) === Object.getPrototypeOf(receiver)
      ) {
        return target
      }
      // early return undefined
      return
    }
      
    // 判断原始数据是否是数组
    const targetIsArray = isArray(target)

    if (!isReadonly) {
      // 当使用代理对象调用相同的方法名时，就会返回对应重写后的方法, 对应代码55行
      if (targetIsArray && hasOwn(arrayInstrumentations, key)) {
        return Reflect.get(arrayInstrumentations, key, receiver)
      }
      if (key === 'hasOwnProperty') {
        return hasOwnProperty
      }
    }

    const res = Reflect.get(target, key, receiver)
    // p103以及p123 如果 key 是 symbol 内置方法，或者访问的是原型对象，直接返回结果，不收集依赖；
    if (isSymbol(key) ? builtInSymbols.has(key) : isNonTrackableKeys(key)) {
      return res
    }
    // 非只读的时候才需要建立响应依赖
    if (!isReadonly) {
      track(target, TrackOpTypes.GET, key)
    }

    // 对浅只读的处理
    if (shallow) {
      return res
    }

    // reactive自动脱ref的功能
    if (isRef(res)) {
      // 如果get的结果是ref，判断是否需要解包；
      // 这里也明确规定了只有对象的某些属性会被解包，数组以及对index属性则不会解包；
      // ref unwrapping - does not apply for Array + integer key.

      return targetIsArray && isIntegerKey(key) ? res : res.value
    }

    if (isObject(res)) {
      // 实现深只读，递归调用readonly将数据包装成只读的代理对象 p112  
      // 深响应数据本质上就是递归调用reactive函数，将其包装成响应式对象并返回 p109
      // isReadonly就是判断转为深只读还是深响应
      return isReadonly ? readonly(res) : reactive(res)
    }

    return res
  }
}

// MutableReactiveHandler继承BaseReactiveHandler，其实也就是继承了get拦截器方法
class MutableReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(false, shallow)
  }

  set(
    target: object,
    key: string | symbol,
    value: unknown,
    receiver: object
  ): boolean {
    let oldValue = (target as any)[key]
    // 如果旧值是只读，并且旧值是ref，新值不是ref，则不允许修改
    if (isReadonly(oldValue) && isRef(oldValue) && !isRef(value)) {
      return false
    }
    // 如果模式不是浅观察
    if (!this._shallow) {
      // 如果新值不是浅响应，且不是只读的
      if (!isShallow(value) && !isReadonly(value)) {
        // 将深响应数据变为原始数据
        oldValue = toRaw(oldValue)
        value = toRaw(value)
      }
      // 目标对象不是数组，旧值是ref，新值不是ref，则直接旧的 oldRef.value 赋值
      // 这一步直接赋值是Ref对象内部的响应式机制处理，方便用户对模板中的ref赋值
      if (!isArray(target) && isRef(oldValue) && !isRef(value)) {
        oldValue.value = value
        return true
      }
    } else {
      // in shallow mode, objects are set as-is regardless of reactive or not
    }

    // 数组和对象设置数据时, set拦截响应逻辑很像, 相当于复用一些代码, 然后增加对这两种数据的不同处理
    // 先区别数组和对象,然后判断是新增操作还是修改操作
    const hadKey =
      isArray(target) && isIntegerKey(key)
        ? Number(key) < target.length // 使用索引修改或增加数据时,判断是否会影响长度
        : hasOwn(target, key) // 判断修改的这个属性是原来就有的,还是新增的
    const result = Reflect.set(target, key, value, receiver)
    
    // 这里就是复用的代码
    // p106 屏蔽由原型引起的不必要更新，只有receiver是target的代理对象时，才触发更新
    if (target === toRaw(receiver)) {
      if (!hadKey) {
        // 新增操作，需要触发的副作用函数
        trigger(target, TriggerOpTypes.ADD, key, value)
      } else if (hasChanged(value, oldValue)) {
        // 对于设置操作，需要比较新数据与旧数据是否相等，进而确定有没有触发响应的必要
        trigger(target, TriggerOpTypes.SET, key, value, oldValue)
      }
    }
    return result
  }

  deleteProperty(target: object, key: string | symbol): boolean {
    const hadKey = hasOwn(target, key)
    const oldValue = (target as any)[key]
    const result = Reflect.deleteProperty(target, key)
    // 判断删除的属性是否存在,并且是否能删除成功
    if (result && hadKey) {
      // 如果可以则触发删除的属性对应的副作用函数
      trigger(target, TriggerOpTypes.DELETE, key, undefined, oldValue)
    }
    return result
  }
  // p93，对于in操作符的拦截
  // 单纯的判断一下是否为内置属性|Symbol 属性，然后触发track，建立TrackOpTypes.HAS与副作用的联系  
  has(target: object, key: string | symbol): boolean {
    const result = Reflect.has(target, key)
    if (!isSymbol(key) || !builtInSymbols.has(key)) {
      track(target, TrackOpTypes.HAS, key)
    }
    return result
  }
    
  // for...in遍历的代理
  // 对象for...in 在p95
  // 数组for...in 在p119  
  ownKeys(target: object): (string | symbol)[] {
    track(
      target,
      TrackOpTypes.ITERATE,
      // 影响for...in对数组的遍历的因素，本质上是数组长度的变化的影响
      // 对数组进行遍历时，因为影响因素的本质是length，所以建立length与副作用函数的依赖
      // 对对象进行遍历时，这个操作明显不与任何具体的键进行绑定，因此我们需要构造唯一的key(ITETATE_KEY)作为表示
      isArray(target) ? 'length' : ITERATE_KEY
    )
    return Reflect.ownKeys(target)
  }
}

// 禁止删除和修改
class ReadonlyReactiveHandler extends BaseReactiveHandler {
  constructor(shallow = false) {
    super(true, shallow)
  }
  // 对于只读的reactive，不允许修改，修改会报警告  
  set(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Set operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
  // 对于只读的reactive，不允许删除，删除会报警告  
  deleteProperty(target: object, key: string | symbol) {
    if (__DEV__) {
      warn(
        `Delete operation on key "${String(key)}" failed: target is readonly.`,
        target
      )
    }
    return true
  }
}

// 创建响应式数据使用的拦截器函数
export const mutableHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new MutableReactiveHandler()

// 创建只读的reactive使用的拦截器函数，禁止删除和修改
export const readonlyHandlers: ProxyHandler<object> =
  /*#__PURE__*/ new ReadonlyReactiveHandler()

// 创建浅响应数据使用的拦截器函数，在 getter 和 setter 中阻止嵌套下响应式
export const shallowReactiveHandlers = /*#__PURE__*/ new MutableReactiveHandler(
  true
)

// 创建浅只读数据使用的拦截器函数，上面两者的结合
export const shallowReadonlyHandlers =
  /*#__PURE__*/ new ReadonlyReactiveHandler(true)
