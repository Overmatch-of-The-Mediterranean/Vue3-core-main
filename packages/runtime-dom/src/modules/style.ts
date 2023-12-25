import { isString, hyphenate, capitalize, isArray } from '@vue/shared'
import { camelize, warn } from '@vue/runtime-core'
import { vShowOldKey } from '../directives/vShow'

type Style = string | Record<string, string | string[]> | null

export function patchStyle(el: Element, prev: Style, next: Style) {
  const style = (el as HTMLElement).style
  // 普通的行内样式 style="font-size: 20px;color: red;font-weight: bold;"
  const isCssString = isString(next)
  // 如果next有值且next不为字符串形式
  if (next && !isCssString) {
    // 如果prev有值且prev不为字符串形式
    if (prev && !isString(prev)) {
      // 去除新style中没有的样式
      for (const key in prev) {
        if (next[key] == null) {
          setStyle(style, key, '')
        }
      }
    }

    // 使用新style覆盖旧style中同属性的值
    for (const key in next) {
      setStyle(style, key, next[key])
    }
  } else {
    const currentDisplay = style.display
    // next为字符串形式
    if (isCssString) {
      // 新旧style不相等，直接用新的style赋值
      if (prev !== next) {
        style.cssText = next as string
      }
    }
    // next没有值的情况
    else if (prev) {
      el.removeAttribute('style')
    }
    /*
        表示元素的' display '由' v-show '控制;
        不管' style '是什么，我们总是保持当前的' display '值
        将控制权移交给' v-show '。
    */
    if (vShowOldKey in el) {
      style.display = currentDisplay
    }
  }
}

const semicolonRE = /[^\\];\s*$/
const importantRE = /\s*!important$/

function setStyle(
  style: CSSStyleDeclaration,
  name: string,
  val: string | string[]
) {
  // 对值是数组情况的处理
  // :style="{ display: ['-webkit-box', '-ms-flexbox', 'flex'] }"
  if (isArray(val)) {
    val.forEach(v => setStyle(style, name, v))
  } else {
    if (val == null) val = ''
    if (__DEV__) {
      if (semicolonRE.test(val)) {
        warn(
          `Unexpected semicolon at the end of '${name}' style value: '${val}'`
        )
      }
    }
    if (name.startsWith('--')) {
      // custom property definition
      style.setProperty(name, val)
    } else {
      const prefixed = autoPrefix(style, name)
      if (importantRE.test(val)) {
        // !important
        style.setProperty(
          hyphenate(prefixed),
          val.replace(importantRE, ''),
          'important'
        )
      } else {
        style[prefixed as any] = val
      }
    }
  }
}

const prefixes = ['Webkit', 'Moz', 'ms']
const prefixCache: Record<string, string> = {}

function autoPrefix(style: CSSStyleDeclaration, rawName: string): string {
  const cached = prefixCache[rawName]
  if (cached) {
    return cached
  }
  let name = camelize(rawName)
  if (name !== 'filter' && name in style) {
    return (prefixCache[rawName] = name)
  }
  name = capitalize(name)
  for (let i = 0; i < prefixes.length; i++) {
    const prefixed = prefixes[i] + name
    if (prefixed in style) {
      return (prefixCache[rawName] = prefixed)
    }
  }
  return rawName
}
