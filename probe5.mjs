const post = async (msg, uid) => {
  const res = await fetch("http://localhost:3000/api/ai", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg, userId: uid }),
  });
  return await res.json();
};
(async () => {
  const a = "dbg_" + Date.now();
  await post("我不吃辣", a);
  const d = await post("今天想辣的发泄", a);
  console.log("reply:", (d.reply||"").slice(0,80));
})();
