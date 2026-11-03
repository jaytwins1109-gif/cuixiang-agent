const post = async (msg, uid) => {
  const res = await fetch("http://localhost:3000/api/ai", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg, userId: uid }),
  });
  return await res.json();
};
const mem = async (uid) => {
  const res = await fetch(`http://localhost:3000/api/memory?userId=${uid}`);
  try { return await res.json(); } catch { return null; }
};
const show = async (m, d, uid) => {
  console.log("Q:", m);
  console.log("   reply:", (d.reply||"").replace(/\n/g," | ").slice(0,140));
  console.log("   cards=%j memory=%j", (d.recommendations||[]).map(c=>c.name), d.memory);
};
(async () => {
  const a = "mc1_" + Date.now();
  await show("我不吃辣", await post("我不吃辣", a), a);
  await show("今天想辣的发泄", await post("今天想辣的发泄", a), a);
  console.log("   [store]", JSON.stringify(await mem(a)).slice(0, 400));
  await show("对", await post("对", a), a);
  console.log("   [store]", JSON.stringify(await mem(a)).slice(0, 400));
  await show("来点吃的", await post("来点吃的", a), a);

  console.log("--- 场景2 ---");
  const b = "mc2_" + Date.now();
  await post("我不吃辣", b);
  await show("今天想辣的发泄", await post("今天想辣的发泄", b), b);
  await show("不是，我开玩笑的", await post("不是，我开玩笑的", b), b);
  console.log("   [store]", JSON.stringify(await mem(b)).slice(0, 400));

  console.log("--- 场景3 ---");
  const c = "mc3_" + Date.now();
  await post("我不吃辣", c);
  await show("今天想辣的发泄", await post("今天想辣的发泄", c), c);
  await show("不是不吃辣，是最近胃不好才不吃的", await post("不是不吃辣，是最近胃不好才不吃的", c), c);
  console.log("   [store]", JSON.stringify(await mem(c)).slice(0, 400));
})();
