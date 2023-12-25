// 对依赖收集的优化 https://juejin.cn/post/6995732683435278344#heading-3
import { ReactiveEffect, trackOpBit } from './effect'

export type Dep = Set<ReactiveEffect> & TrackedMarkers

type TrackedMarkers = {
  /**
   * wasTracked 已经被收集的依赖集合
   */
  w: number
  /**
   * newTracked 新收集的依赖集合
   */
  n: number
}

// 创建收集副作用函数的set集合
export const createDep = (effects?: ReactiveEffect[]): Dep => {
  const dep = new Set<ReactiveEffect>(effects) as Dep
  dep.w = 0
  dep.n = 0
  return dep
}

// 判断该依赖是否已经被收集
/*
   通过与运算的结果是否大于 0 来判断，这就要求依赖被收集时嵌套的层级要匹配。
   举个例子，假设此时 dep.w 的值是 2，说明它是在第一层执行 effect 函数时创建的，
   但是这时候已经执行了嵌套在第二层的 effect 函数，trackOpBit 左移两位变成了 4，
   2 & 4 的值是 0，那么 wasTracked 函数返回值为 false，说明需要收集这个依赖。显然，这个需求是合理的。
*/

export const wasTracked = (dep: Dep): boolean => (dep.w & trackOpBit) > 0

// 判断依赖是否是新的未被收集的依赖
export const newTracked = (dep: Dep): boolean => (dep.n & trackOpBit) > 0

export const initDepMarkers = ({ deps }: ReactiveEffect) => {
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      // 使用或运算，确保这一层级的依赖被标记为已收集
      deps[i].w |= trackOpBit // 标记依赖已经被收集
    }
  }
}

export const finalizeDepMarkers = (effect: ReactiveEffect) => {
  const { deps } = effect
  if (deps.length) {
    //ptr的作用是：将哪些依赖集合已经被收集，新一轮依赖收集中还需要收集的，将副作用函数继续保留在dep中，dep继续保留在副作用函数所依赖的集合deps中
    let ptr = 0
    for (let i = 0; i < deps.length; i++) {
      const dep = deps[i]
      // 找到哪些曾经被收集过，在新的一轮依赖收集中却没有被收集的依赖，从deps中删除
      if (wasTracked(dep) && !newTracked(dep)) {
        dep.delete(effect)
      } else {
        // 保留副作用函数在dep中
        deps[ptr++] = dep
      }
      // 清空状态，~的意思是按位非，p51页，调式源码走一遍这个例子就能明白了
      // 清空状态是为下次触发时，将副作用函数从某些不会再访问的代理属性对应的依赖集合中删除掉做准备
      // 就是在fn执行时，访问代理数据的属性时，会进入getter中，其又会执行track，
      // track里面调用trackEffects，trackEffects中这个语句if(!newTracked(dep))
      // 此时fn中访问的代理属性对应的dep.n = 0，进入语句体，并dep.n赋值，因为此时dep.w有值
      // 说明，依赖集合已经被收集，新一轮依赖收集中还需要收集，这样的话，再fn执行完后，进入finally语句
      // finally语句体中，为回退到上一层做一些处理，且调用finalizeDepMarkers将副作用函数从某些不会再访问的代理属性对应的依赖集合中删除掉
      // 因为被访问的代理属性对应的dep集合的dep.n和dep.w都有值，所以该副作用函数不会被从dep删除掉
      // 而没被访问的代理属性对应的dep，只有dep.w在initDepMarkers中会被赋值，因为不会被访问，所以不会进入track
      // 进而dep.n = 0，没被访问的代理属性对应的dep在finalizeDepMarkers，会将该副作用函数从其dep中删除掉
      dep.w &= ~trackOpBit
      dep.n &= ~trackOpBit
    }
    deps.length = ptr
  }
}
