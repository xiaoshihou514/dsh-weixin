/** Browser contribution: a discoverable Weixin card in Settings -> Plugins. */

import { createElement, useState, type CSSProperties } from 'react'

interface WeixinCardFace {
  title: string
  description: string
  action: string
}

interface SlotRegistration<T> {
  name: 'settings.plugin.item'
  key: string
  inject: () => T
}

interface ClientContext {
  slots: {
    inject(name: 'settings.plugin.item', callback: () => Iterable<unknown>): void
    register<T>(options: SlotRegistration<T>, component: (props: T) => unknown): unknown
  }
}

const card: CSSProperties = {
  listStyle: 'none',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '12px',
  background: 'var(--dsw-alias-bg-layer-3)',
}

const button: CSSProperties = {
  appearance: 'none',
  border: '1px solid transparent',
  borderRadius: '8px',
  padding: '5px 14px',
  font: 'inherit',
  fontSize: '13px',
  lineHeight: 1.5,
  cursor: 'pointer',
  color: 'var(--dsw-alias-bg-layer-3)',
  background: 'var(--dsw-alias-label-primary)',
}

function WeixinCard(props: WeixinCardFace) {
  const [open, setOpen] = useState(false)
  return createElement('li', { style: card },
    createElement('button', {
      type: 'button',
      'aria-expanded': open,
      'aria-label': `${open ? '收起' : '展开'}：${props.title}`,
      onClick: () => { setOpen(!open) },
      style: { appearance: 'none', width: '100%', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', background: 'transparent', border: 0, borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '12px', padding: '14px 16px' },
    },
    createElement('span', { style: { display: 'flex', flexDirection: 'column', flex: 1, gap: '4px', minWidth: 0 } },
      createElement('span', { style: { color: 'var(--dsw-alias-label-primary)', fontSize: '15px', fontWeight: 600, lineHeight: 1.4 } }, props.title),
      createElement('span', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: 1.5 } }, props.description),
    ),
    createElement('svg', {
      width: 14,
      height: 14,
      viewBox: '0 0 14 14',
      fill: 'none',
      'aria-hidden': true,
      style: { color: 'var(--dsw-alias-label-tertiary)', flex: 'none', transform: open ? 'rotate(180deg)' : undefined, transition: 'transform .16s' },
    }, createElement('path', {
      d: 'M11.8486 5.5L11.4238 5.92383L8.69727 8.65137C8.44157 8.90706 8.21562 9.13382 8.01172 9.29785C7.79912 9.46883 7.55595 9.61756 7.25 9.66602C7.08435 9.69222 6.91565 9.69222 6.75 9.66602C6.44405 9.61756 6.20088 9.46883 5.98828 9.29785C5.78438 9.13382 5.55843 8.90706 5.30273 8.65137L2.57617 5.92383L2.15137 5.5L3 4.65137L3.42383 5.07617L6.15137 7.80273C6.42595 8.07732 6.59876 8.24849 6.74023 8.3623C6.87291 8.46904 6.92272 8.47813 6.9375 8.48047C6.97895 8.48703 7.02105 8.48703 7.0625 8.48047C7.07728 8.47813 7.12709 8.46904 7.25977 8.3623C7.40124 8.24849 7.57405 8.07732 7.84863 7.80273L10.5762 5.07617L11 4.65137L11.8486 5.5Z',
      fill: 'currentColor',
    }))),
    open ? createElement('div', { style: { borderTop: '1px solid var(--dsw-alias-border-l2)', margin: '0 16px', padding: '12px 0 8px' } },
      createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', padding: '0 0 4px' } },
        createElement('button', {
          type: 'button',
          style: button,
          onClick: () => { window.location.assign('/dsh-weixin/login') },
        }, props.action),
      ),
    ) : null,
  )
}

export const inject = ['slots']

/** Register one lightweight card; account setup remains on the dedicated QR page. */
export function apply(ctx: ClientContext): void {
  const face: WeixinCardFace = {
    title: '微信',
    description: '通过微信继续当前会话，并收发消息和文件。',
    action: '连接微信',
  }
  ctx.slots.inject('settings.plugin.item', function* () {
    yield ctx.slots.register({
      name: 'settings.plugin.item',
      key: 'dsh-weixin',
      inject: () => face,
    }, WeixinCard)
  })
}
