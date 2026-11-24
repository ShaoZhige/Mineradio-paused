// 生成 apple-music-lyrics 的录制输入。故意手写：rust-anything 自动生成的边界用例
// 对这种"吃一份 XML 吐两段文本"的函数毫无意义（它只会喂 {} / null / true）。
//
// 用法：node scripts/record-apple-music-lyrics.js > ztest/ra-am-lyrics/inputs.jsonl
'use strict';

const cases = [];
const push = (ttml) => cases.push({ fn: 'convertAppleMusicTtmlToLyric', args: [ttml] });

// 1) 标准逐字 TTML：主唱 v1 + 背景和声 v2（背景必须被丢掉）
push(`<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyrics">
<body><div>
<p begin="00:00:12.345" end="00:00:15.678" ttm:agent="v1" itunes:key="L1">
<span begin="00:00:12.345" end="00:00:12.600">我</span><span begin="00:00:12.600" end="00:00:12.900">的</span><span begin="00:00:12.900" end="00:00:13.400">世界</span>
</p>
<p begin="00:00:16.000" end="00:00:18.000" ttm:agent="v2" ttm:role="x-bg"><span begin="00:00:16.000" end="00:00:18.000">和声</span></p>
<p begin="00:00:19.000" end="00:00:21.500" ttm:agent="v1"><span begin="00:00:19.000" end="00:00:19.500">再</span><span begin="00:00:19.500" end="00:00:21.500">一次</span></p>
</div></body></tt>`);

// 2) 只有行级时间（无 span）：只出 LRC，yrc 必须为空
push(`<tt itunes:timing="Line"><body><div>
<p begin="00:00:05.000" end="00:00:09.000" ttm:agent="v1">第一行歌词</p>
<p begin="00:00:09.000" end="00:00:13.250" ttm:agent="v1">第二行歌词</p>
</div></body></tt>`);

// 3) 三种时间写法混用：hh:mm:ss.SSS / mm:ss.SSS / 纯秒
push(`<tt><body><div>
<p begin="01:02:03.500" end="01:02:05.000" ttm:agent="v1">长时长</p>
<p begin="02:03.500" end="02:05.250" ttm:agent="v1">分秒</p>
<p begin="125.75" end="128.25" ttm:agent="v1">纯秒</p>
</div></body></tt>`);

// 4) 实体解码：数字、十六进制、命名、以及 &amp;lt; 不能被二次解码
push(`<tt><body><div>
<p begin="0.000" end="2.000" ttm:agent="v1">A &amp; B &lt;tag&gt; &quot;q&quot; &apos;s&apos;</p>
<p begin="2.000" end="4.000" ttm:agent="v1">&#20013;&#x6587;&nbsp;空格</p>
<p begin="4.000" end="6.000" ttm:agent="v1">实体 &amp;lt; 与 &#65;</p>
</div></body></tt>`);

// 5) 注音：<rt> 与 <rp> 都要丢，不能漏进歌词
push(`<tt><body><div>
<p begin="0.000" end="3.000" ttm:agent="v1"><span begin="0.000" end="1.500"><ruby>漢<rp>(</rp><rt>かん</rt><rp>)</rp></ruby></span><span begin="1.500" end="3.000">字</span></p>
</div></body></tt>`);

// 6) 拉丁文：词落在 span 里、空格落在 span 之间的裸文本里
push(`<tt><body><div>
<p begin="10.000" end="14.000" ttm:agent="v1"><span begin="10.000" end="10.320">Hello</span> <span begin="10.320" end="10.640">world</span> <span begin="10.640" end="11.000">again</span></p>
</div></body></tt>`);

// 7) 词里的半角括号必须换成全角，否则 YRC 解析会把后面的词吃掉
push(`<tt><body><div>
<p begin="0.000" end="4.000" ttm:agent="v1"><span begin="0.000" end="1.000">(Oh)</span><span begin="1.000" end="2.000">yeah</span><span begin="2.000" end="4.000">(x2)</span></p>
</div></body></tt>`);

// 8) 整段只有背景人声：不能把整首歌的歌词全丢光（这里本来就没有主唱）
push(`<tt><body><div>
<p begin="0.000" end="2.000" ttm:agent="v2" ttm:role="x-bg"><span begin="0.000" end="2.000">啊</span></p>
</div></body></tt>`);

// 9) 全部标成 v2（有 v1 才丢 v2；没有 v1 时一刀切会得到空歌词）
push(`<tt><body><div>
<p begin="0.000" end="2.000" ttm:agent="v2">全是 v2 第一句</p>
<p begin="2.000" end="4.000" ttm:agent="v2">全是 v2 第二句</p>
</div></body></tt>`);

// 10) 空 / 非字符串 / 没有 <p> / 只有空白 —— 一律 null
push('');
push('   \n\t  ');
push(null);
push(undefined);
push('<tt><body><div></div></body></tt>');
push('这不是 XML，只是一句话');

// 11) <p> 没有 begin，但 span 有：起点从第一个词取，终点从最后一个词取
push(`<tt><body><div>
<p ttm:agent="v1"><span begin="3.000" end="3.500">起点</span><span begin="3.500" end="4.250">靠词</span></p>
</div></body></tt>`);

// 12) end <= start（残缺样本）：要给一个按字数估出来的时长
push(`<tt><body><div>
<p begin="5.000" end="4.000" ttm:agent="v1">结束早于开始</p>
<p begin="6.000" end="6.000" ttm:agent="v1">零长度行</p>
</div></body></tt>`);

// 13) 行序打乱：输出必须按 start 升序
push(`<tt><body><div>
<p begin="9.000" end="11.000" ttm:agent="v1">第三</p>
<p begin="1.000" end="3.000" ttm:agent="v1">第一</p>
<p begin="5.000" end="7.000" ttm:agent="v1">第二</p>
</div></body></tt>`);

// 14) 背景人声与主唱混在同一行的 span 里：只丢背景 span，不丢整行
push(`<tt><body><div>
<p begin="0.000" end="4.000" ttm:agent="v1"><span begin="0.000" end="2.000">主唱</span><span begin="2.000" end="4.000" ttm:role="x-bg">和声</span></p>
</div></body></tt>`);

// 15) 词里嵌了别的标签（<b>/<i>/<span>）：文字要留下，标签要走
push(`<tt><body><div>
<p begin="0.000" end="3.000" ttm:agent="v1"><span begin="0.000" end="1.500"><b>粗</b>体</span><span begin="1.500" end="3.000"><i>斜</i><br/>体</span></p>
</div></body></tt>`);

// 16) 跨行空白压缩：换行/制表符在拼行时压成一个空格
push(`<tt><body><div>
<p begin="0.000" end="3.000" ttm:agent="v1">
   多  个
   空白
</p>
</div></body></tt>`);

// 17) 只有一个词的 span：words.length === 1 时不算逐字（yrc 必须为空）
push(`<tt><body><div>
<p begin="0.000" end="3.000" ttm:agent="v1"><span begin="0.000" end="3.000">整行一个词</span></p>
</div></body></tt>`);

// 18) 小数时间 + 需要四舍五入到百分之一秒（59.996 不能写成 [00:60.00]）
push(`<tt><body><div>
<p begin="59.996" end="60.500" ttm:agent="v1">临界秒</p>
<p begin="3599.999" end="3601.000" ttm:agent="v1">临界小时</p>
</div></body></tt>`);

// 19) span 没有 begin/end：这个词没有时间，仍然要进文本，但不能进 words
push(`<tt><body><div>
<p begin="0.000" end="3.000" ttm:agent="v1"><span>无时间词</span><span begin="1.000" end="2.000">有时间词</span></p>
</div></body></tt>`);

// 20) itunes:timing 出现在根节点：timing 字段要如实带出
push(`<tt xmlns:itunes="http://music.apple.com/lyrics" itunes:timing="Word"><body><div>
<p begin="0.000" end="2.000" ttm:agent="v1"><span begin="0.000" end="1.000">逐</span><span begin="1.000" end="2.000">字</span></p>
</div></body></tt>`);

// 21) 以下 7 条直接取自 `tests/apple-music-lyrics.test.js` 的真实包裹形状
//     （`<body dur>` + `<div begin/end>` + 另一个 itunes 命名空间 URL）。
//     生产里 companion 返回的就是这个样子，所以不能只测简写的 `<tt>`。
const wrapped = (body, timing) => [
  '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" itunes:timing="',
  timing || 'Word',
  '"><body dur="00:04.000"><div begin="00:00.000" end="00:04.000">',
  body,
  '</div></body></tt>',
].join('');

push(wrapped(
  '<p begin="00:01.000" end="00:03.000" ttm:agent="v1">'
  + '<span begin="00:01.000" end="00:01.500">Hello</span> '
  + '<span begin="00:01.500" end="00:02.500">world</span></p>'
));

push(wrapped(
  '<p begin="00:12.345" end="00:13.400">'
  + '<span begin="00:12.345" end="00:12.600">我</span>'
  + '<span begin="00:12.600" end="00:12.900">的</span>'
  + '<span begin="00:12.900" end="00:13.400">爱</span></p>'
));

push(wrapped(
  '<p begin="00:01.000" end="00:03.500"><span begin="00:01.000" end="00:03.500">整句歌词</span></p>',
  'Line'
));

push(wrapped(
  '<p begin="00:01.000" end="00:02.000" ttm:agent="v1">主唱</p>'
  + '<p begin="00:01.000" end="00:02.000" ttm:agent="v2">和声</p>'
  + '<p begin="00:03.000" end="00:04.000" ttm:agent="v1">'
  + '主句<span ttm:role="x-bg" begin="00:03.200" end="00:03.500">(oh)</span></p>'
));

push(wrapped('<p begin="00:01.000" end="00:02.000" ttm:agent="v2">只有和声标注</p>'));

push(wrapped(
  '<p begin="00:01.000" end="00:02.000">Rock &amp; Roll</p>'
  + '<p begin="00:02.000" end="00:03.000"></p>'
));

push(wrapped(
  '<p begin="00:01.000" end="00:02.000">'
  + '<span begin="00:01.000" end="00:01.500">(Oh)</span>'
  + '<span begin="00:01.500" end="00:02.000">yeah</span></p>'
));

for (const item of cases) process.stdout.write(JSON.stringify(item) + '\n');
process.stderr.write(`共 ${cases.length} 条输入\n`);