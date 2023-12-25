import {
  Component,
  ConcreteComponent,
  currentInstance,
  ComponentInternalInstance,
  isInSSRComponentSetup,
  ComponentOptions
} from './component'
import { isFunction, isObject } from '@vue/shared'
import { ComponentPublicInstance } from './componentPublicInstance'
import { createVNode, VNode } from './vnode'
import { defineComponent } from './apiDefineComponent'
import { warn } from './warning'
import { ref } from '@vue/reactivity'
import { handleError, ErrorCodes } from './errorHandling'
import { isKeepAlive } from './components/KeepAlive'
import { queueJob } from './scheduler'

export type AsyncComponentResolveResult<T = Component> = T | { default: T } // es modules

export type AsyncComponentLoader<T = any> = () => Promise<
  AsyncComponentResolveResult<T>
>

export interface AsyncComponentOptions<T = any> {
  loader: AsyncComponentLoader<T>
  loadingComponent?: Component
  errorComponent?: Component
  delay?: number
  timeout?: number
  suspensible?: boolean
  onError?: (
    error: Error,
    retry: () => void,
    fail: () => void,
    attempts: number
  ) => any
}

export const isAsyncWrapper = (i: ComponentInternalInstance | VNode): boolean =>
  !!(i.type as ComponentOptions).__asyncLoader

/*! #__NO_SIDE_EFFECTS__ */
// 返回一个包装组件，包装组件根据加载器的状态来决定渲染什么内容。组件加载成功渲染则渲染被加载的组件，组件渲染失败则渲染占位内容
export function defineAsyncComponent<
  T extends Component = { new (): ComponentPublicInstance }
>(source: AsyncComponentLoader<T> | AsyncComponentOptions<T>): T {
  // 针对只传异步加载器的情况，defineAsyncComponent(() => import(xxx))
  // 需要统一为一个对象，所以只传加载器，需要将其放在对象里
  if (isFunction(source)) {
    source = { loader: source }
  }

  const {
    loader, // 异步加载器
    loadingComponent, // loading时，显示的loading组件
    errorComponent, // 加载发生错误时，显示的组件
    delay = 200, // 控制loading组件在延迟多长时间后显示
    timeout, // 设置请求超时时长 undefined = never times out
    suspensible = true,
    onError: userOnError // 请求错误时，控制权交给用户，让用户决定报错还是重新请求
  } = source

  
  let pendingRequest: Promise<ConcreteComponent> | null = null
  
  // 保存异步加载成功加载的组件
  let resolvedComp: ConcreteComponent | undefined

  // 记录重试次数
  let retries = 0
  
  // 封装重试请求函数
  const retry = () => {
    retries++
    pendingRequest = null
    return load()
  }

  // 将调用异步加载器封装在这个函数中，同时将不同状态的结果对应的处理也封装进去
  const load = (): Promise<ConcreteComponent> => {
    let thisRequest: Promise<ConcreteComponent>
    return (
      pendingRequest ||
      (thisRequest = pendingRequest =
        loader()
           // 捕获加载器的错误，组件加载失败
          .catch(err => {
            err = err instanceof Error ? err : new Error(String(err))
            if (userOnError) {
              // 如果用户传入了onError，返回一个新的promise
              return new Promise((resolve, reject) => {
                const userRetry = () => resolve(retry())
                const userFail = () => reject(err)
                // 将错误err传递给onError，并将控制权交给用户，让用户决定下步怎么做
                userOnError(err, userRetry, userFail, retries + 1)
              })
            } else {
              throw err
            }
          })
          // 组件加载成功后的处理
          .then((comp: any) => {
            if (thisRequest !== pendingRequest && pendingRequest) {
              return pendingRequest
            }
            if (__DEV__ && !comp) {
              warn(
                `Async component loader resolved to undefined. ` +
                  `If you are using retry(), make sure to return its return value.`
              )
            }
            // interop module default
            if (
              comp &&
              (comp.__esModule || comp[Symbol.toStringTag] === 'Module')
            ) {
              comp = comp.default
            }
            if (__DEV__ && comp && !isObject(comp) && !isFunction(comp)) {
              throw new Error(`Invalid async component load result: ${comp}`)
            }
            // 将请求成功的组件保存起来，下面会使用
            resolvedComp = comp
            // 应对的第一种情况：请求异步组件一次成功，load调用会返回一个promise。在这里返回的就是fulfilled状态的promise，执行下面206行的then回调
            /*
                应对的第二种情况：多次重试请求异步组件成功，第92行const userRetry = () => resolve(retry())，retry返回一个fulfilled状态的promise，
                                一直往外层返回fulfilled状态的promise，直到最外层第206行代码。
            */
            return comp
          }))
    )
  }

  // 返回一个包装组件，包装组件根据加载器的状态来决定渲染什么内容。组件加载成功渲染则渲染被加载的组件，组件渲染失败则渲染占位内容
  return defineComponent({
    name: 'AsyncComponentWrapper',

    __asyncLoader: load,

    get __asyncResolved() {
      return resolvedComp
    },

    setup() {
      // 传入的instance是包装组件对应的组件实例，包装组件起到暂时保留数据的作用，当决定真正要渲染的组件后，将数据传递给真正要渲染的组件
      const instance = currentInstance!

      // 异步组件已经加载过了，则直接返回
      if (resolvedComp) {
        return () => createInnerComp(resolvedComp!, instance)
      }

      // 进行报错的函数，于用户传递的onError作用完全不一样，不要被名字搞混
      const onError = (err: Error) => {
        pendingRequest = null
        handleError(
          err,
          instance,
          ErrorCodes.ASYNC_COMPONENT_LOADER,
          !errorComponent /* do not throw in dev if user provided error component */
        )
      }

      // suspense-controlled or SSR.
      if (
        (__FEATURE_SUSPENSE__ && suspensible && instance.suspense) ||
        (__SSR__ && isInSSRComponentSetup)
      ) {
        return load()
          .then(comp => {
            return () => createInnerComp(comp, instance)
          })
          .catch(err => {
            onError(err)
            return () =>
              errorComponent
                ? createVNode(errorComponent as ConcreteComponent, {
                    error: err
                  })
                : null
          })
      }

      // 是否加载成功
      const loaded = ref(false)
      // 记录错误不同类型的错误原因
      const error = ref()
      // 是否延迟loading显示
      const delayed = ref(!!delay)

      // 如果延迟，需要开启一个定时器，在delay时间后，delayed改为false，意味着显示loading组件
      if (delay) {
        setTimeout(() => {
          delayed.value = false
        }, delay)
      }

      // 如果设置超长时间，在加载前先开启一个定时器，超时后生成一个错误err，并记录错误err
      if (timeout != null) {
        setTimeout(() => {
          if (!loaded.value && !error.value) {
            const err = new Error(
              `Async component timed out after ${timeout}ms.`
            )
            // 将err传递给报错函数，进行报错
            onError(err)
            error.value = err
          }
        }, timeout)
      }

      // 加载异步组件
      load()
        .then(() => {
          // 加载成功
          loaded.value = true
          if (instance.parent && isKeepAlive(instance.parent.vnode)) {
            // parent is keep-alive, force update so the loaded component's
            // name is taken into account
            queueJob(instance.parent.update)
          }
        })
        .catch(err => {
          // 加载失败后进行报错
          onError(err)
          error.value = err
        })

      return () => {
        if (loaded.value && resolvedComp) {
          // 加载成功且有组件，返回加载的组件进行渲染显示
          return createInnerComp(resolvedComp, instance)
        } else if (error.value && errorComponent) {
          // 加载失败且有错误组件，则将错误信息传递给改组件，返回配置的错误组件进行渲染显示
          return createVNode(errorComponent, {
            error: error.value
          })
        } else if (loadingComponent && !delayed.value) {
          // 配置的有加载组件且此时可以显示加载组件，返回配置的加载组件进行渲染显示
          return createVNode(loadingComponent)
        }
      }
    }
  }) as T
}

// 用来创建defineAsyncComponent真正要渲染的组件
function createInnerComp(
  comp: ConcreteComponent,
  parent: ComponentInternalInstance // 传入的instance是包装组件对应的组件实例，包装组件起到暂时保留数据的作用，当决定真正要渲染的组件后，将数据传递给真正要渲染的组件
) {
  const { ref, props, children, ce } = parent.vnode
  const vnode = createVNode(comp, props, children)
  // ensure inner component inherits the async wrapper's ref owner
  vnode.ref = ref
  // pass the custom element callback on to the inner comp
  // and remove it from the async wrapper
  vnode.ce = ce
  delete parent.vnode.ce

  return vnode
}
