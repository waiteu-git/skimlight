/**
 * お気に入りに登録する1行（javascript: の URL）を作る。
 * 1. このサイトの bm.js を読み込み、ページの上にマーカーを引く。読み込みには開いていたページのアドレスを付けない（no-referrer）。
 * 2. ページの CSP で読み込めない時は、本文の文字（innerText）を読み取りビューの窓へ postMessage で渡す
 *    （宛先はこのサイトの origin に固定。読み取りビューが「準備できた」と返してから渡す）。
 */
export function bookmarkletHref(origin: string): string {
  const o = JSON.stringify(origin);
  const code = `(()=>{const o=${o};const go=()=>{const w=open(o+'/#bm','_blank');if(!w){alert('読み取りビューの窓を開けませんでした（ポップアップを許可してください）');return}` +
    `const t=((document.querySelector('main,[role=main]')||document.body).innerText||'').slice(0,200000);` +
    `addEventListener('message',function f(e){if(e.origin===o&&e.source===w&&e.data&&e.data.type==='skimlight/ready'){` +
    `w.postMessage({type:'skimlight/text',url:location.href.split('#')[0],title:document.title,text:t},o);removeEventListener('message',f)}})};` +
    `if(window.__skimlightOverlay){window.__skimlightOverlay.undo();return}` +
    `const s=document.createElement('script');s.referrerPolicy='no-referrer';s.src=o+'/bm.js';s.onerror=go;document.documentElement.append(s)})()`;
  return "javascript:" + encodeURIComponent(code).replace(/%20/g, " ");
}
