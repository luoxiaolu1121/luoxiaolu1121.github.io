const STORAGE_KEY = "qingshen-state-v1";
const PHOTO_DB = "qingshen-photos-v1";
const quickFoods = [
  { name: "米饭", kcal: 232, portion: "约 1 碗 / 200g" },
  { name: "鸡胸肉", kcal: 248, portion: "约 150g" },
  { name: "鸡蛋", kcal: 140, portion: "约 2 个" },
  { name: "面条", kcal: 420, portion: "约 1 碗" },
  { name: "炒蔬菜", kcal: 180, portion: "约 1 盘" },
  { name: "牛肉饭", kcal: 620, portion: "约 1 份" },
  { name: "沙拉", kcal: 280, portion: "含酱约 1 份" },
  { name: "拿铁", kcal: 180, portion: "约 350ml" }
];

const defaultState = { profile: null, meals: [], weights: [], completedActions: [], createdAt: new Date().toISOString() };
let state = loadState();
let pendingPhoto = null;
let deferredInstallPrompt = null;

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const todayKey = () => new Date().toLocaleDateString("sv-SE");
const fmtDate = (value, options = { month: "short", day: "numeric" }) => new Intl.DateTimeFormat("zh-CN", options).format(new Date(`${value}T12:00:00`));

function loadState() {
  try { return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") }; }
  catch { return { ...defaultState }; }
}
function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

function openPhotoDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PHOTO_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("photos");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function photoPut(id, blob) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("photos", "readwrite");
    tx.objectStore("photos").put(blob, id);
    tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
  });
}
async function photoGet(id) {
  const db = await openPhotoDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("photos").objectStore("photos").get(id);
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
async function photoDelete(id) {
  const db = await openPhotoDb();
  const tx = db.transaction("photos", "readwrite");
  tx.objectStore("photos").delete(id);
}

function planFor(profile = state.profile) {
  if (!profile) return null;
  const weight = Number(profile.weight), height = Number(profile.height), age = Number(profile.age);
  const bmr = 10 * weight + 6.25 * height - 5 * age + (profile.sex === "male" ? 5 : -161);
  const tdee = Math.round(bmr * Number(profile.activity));
  const desiredDeficit = Number(profile.pace) * 7700 / 7;
  const floor = profile.sex === "male" ? 1500 : 1200;
  const calories = Math.round(Math.max(floor, tdee - desiredDeficit) / 10) * 10;
  const actualPace = Math.max(0, Math.round(((tdee - calories) * 7 / 7700) * 100) / 100);
  const remainingKg = Math.max(0, weight - Number(profile.goal));
  const weeks = actualPace > 0 ? Math.ceil(remainingKg / actualPace) : 0;
  const targetDate = new Date(); targetDate.setDate(targetDate.getDate() + weeks * 7);
  return { bmr: Math.round(bmr), tdee, calories, pace: actualPace, weeks, targetDate, wasClamped: calories > tdee - desiredDeficit };
}

function mealsToday() { return state.meals.filter((m) => m.date === todayKey()); }
function totalToday() { return mealsToday().reduce((sum, item) => sum + Number(item.calories), 0); }

function updateUI() {
  const now = new Date();
  $("#todayLabel").textContent = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(now);
  $("#greeting").textContent = state.profile?.name ? `${timeGreeting()}，${state.profile.name}` : "今天，稳稳向前";
  const plan = planFor();
  const consumed = totalToday();
  const target = plan?.calories || 0;
  const remaining = target ? target - consumed : null;
  $("#remainingCalories").textContent = remaining === null ? "—" : Math.max(0, remaining).toLocaleString("zh-CN");
  $("#consumedCalories").textContent = `已摄入 ${consumed || 0}`;
  $("#targetCalories").textContent = `目标 ${target || "—"}`;
  const percent = target ? Math.min(100, Math.round(consumed / target * 100)) : 0;
  $("#ringPercent").textContent = `${percent}%`;
  $("#calorieRing").style.setProperty("--progress", `${percent * 3.6}deg`);
  $("#calorieRing").setAttribute("aria-label", `今日热量已使用百分之 ${percent}`);
  $("#streakValue").textContent = calculateStreak();
  $("#goalDistance").textContent = state.profile ? `${Math.max(0, Number(state.profile.weight) - Number(state.profile.goal)).toFixed(1)} kg` : "— kg";
  $("#weeklyTrend").textContent = weeklyTrendText();
  renderMeals();
  renderPlan(plan);
  renderProgress();
  renderCoach(plan, consumed);
}

function timeGreeting() { const h = new Date().getHours(); return h < 11 ? "早上好" : h < 18 ? "下午好" : "晚上好"; }
function calculateStreak() {
  const days = new Set(state.meals.map((m) => m.date));
  let streak = 0; const cursor = new Date();
  while (days.has(cursor.toLocaleDateString("sv-SE"))) { streak++; cursor.setDate(cursor.getDate() - 1); }
  return streak;
}
function weeklyTrendText() {
  if (state.weights.length < 2) return "待记录";
  const sorted = [...state.weights].sort((a,b) => a.date.localeCompare(b.date));
  const recent = sorted.slice(-7);
  const delta = Number(recent.at(-1).weight) - Number(recent[0].weight);
  if (Math.abs(delta) < .05) return "基本稳定";
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`;
}

async function renderMeals() {
  const container = $("#mealList");
  const items = mealsToday().sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  container.innerHTML = "";
  $("#mealEmpty").hidden = items.length > 0;
  for (const meal of items) {
    const row = document.createElement("article"); row.className = "meal-item";
    let thumb = `<div class="meal-thumb" aria-hidden="true">${meal.type === "早餐" ? "☀" : meal.type === "晚餐" ? "☾" : "◉"}</div>`;
    if (meal.photoId) {
      try { const blob = await photoGet(meal.photoId); if (blob) thumb = `<img class="meal-thumb" src="${URL.createObjectURL(blob)}" alt="${escapeHtml(meal.name)}照片" />`; } catch {}
    }
    row.innerHTML = `${thumb}<div><h3>${escapeHtml(meal.name)}</h3><p>${escapeHtml(meal.type)} · ${escapeHtml(meal.portion || "份量未填写")}</p></div><div class="meal-kcal"><strong>${Number(meal.calories).toLocaleString("zh-CN")}</strong><small>千卡</small><button class="delete-meal" data-delete-meal="${meal.id}" type="button">删除</button></div>`;
    container.append(row);
  }
}

function renderPlan(plan) {
  const values = { "#planDate": "—", "#planDuration": "完善资料后生成", "#planGoalWeight": "—", "#planCalories": "—", "#planPace": "—", "#planTdee": "—" };
  if (plan && state.profile) {
    values["#planDate"] = plan.weeks ? new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long" }).format(plan.targetDate) : "已到达目标";
    values["#planDuration"] = plan.weeks ? `约 ${plan.weeks} 周，按当前节奏估算` : "接下来以稳定维持为主";
    values["#planGoalWeight"] = Number(state.profile.goal).toFixed(1);
    values["#planCalories"] = plan.calories;
    values["#planPace"] = plan.pace.toFixed(2);
    values["#planTdee"] = plan.tdee;
  }
  Object.entries(values).forEach(([sel, value]) => $(sel).textContent = value);
  const actions = plan ? [
    ["1", "记录至少两餐", "先建立真实基线，不要求第一天就做到完美。"],
    ["2", "每餐先看蛋白质和蔬菜", "用更有饱腹感的组合，减少靠意志力硬扛。"],
    ["3", "安排 20–30 分钟步行", "选一个能长期重复的时间段，饭后也可以。"]
  ] : [["1", "完成个人资料", "填入身高、体重与活动量，生成你的第一版计划。"]];
  $("#actionList").innerHTML = actions.map((a) => `<article class="action-item"><span>${a[0]}</span><div><strong>${a[1]}</strong><p>${a[2]}</p></div></article>`).join("");
}

function renderCoach(plan, consumed) {
  if (!plan) return void ($("#coachText").textContent = "先完成个人资料，我会为你生成今天的可执行建议。");
  const remaining = plan.calories - consumed;
  let text = "先记录今天真实吃了什么，不用刻意少报。准确的基线比“完美的一天”更有价值。";
  if (consumed > 0 && remaining > 500) text = `今天还可安排约 ${remaining} 千卡。下一餐优先选一份蛋白质、两份蔬菜和适量主食。`;
  if (remaining >= 0 && remaining <= 500) text = `今天还剩约 ${remaining} 千卡。若已接近睡前，先判断是真饿还是习惯性想吃。`;
  if (remaining < 0) text = `今天比目标多约 ${Math.abs(remaining)} 千卡，不需要补偿性节食。下一餐回到正常计划即可。`;
  $("#coachText").textContent = text;
}

function renderProgress() {
  const sorted = [...state.weights].sort((a,b) => a.date.localeCompare(b.date));
  const current = sorted.at(-1)?.weight || state.profile?.weight;
  $("#currentWeight").textContent = current ? Number(current).toFixed(1) : "—";
  let changeText = "等待更多记录";
  if (sorted.length >= 2) { const delta = Number(sorted.at(-1).weight) - Number(sorted[0].weight); changeText = `累计 ${delta > 0 ? "+" : ""}${delta.toFixed(1)} kg`; }
  $("#weightChange").textContent = changeText;
  $("#weightHistory").innerHTML = sorted.slice(-8).reverse().map((w) => `<div class="weight-row"><span>${fmtDate(w.date, { year: "numeric", month: "long", day: "numeric" })}</span><strong>${Number(w.weight).toFixed(1)} kg</strong></div>`).join("") || `<div class="empty-state"><p>记录两次以上，就能看到体重趋势。</p></div>`;
  drawWeightChart(sorted.slice(-30));
}

function drawWeightChart(data) {
  const canvas = $("#weightChart"); const box = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, box.width * dpr); canvas.height = Math.max(1, box.height * dpr);
  const ctx = canvas.getContext("2d"); ctx.scale(dpr, dpr); const w = box.width, h = box.height;
  ctx.clearRect(0,0,w,h); ctx.strokeStyle = "rgba(229,255,247,.08)"; ctx.lineWidth = 1;
  for (let i=1;i<4;i++){ const y=h*i/4; ctx.beginPath(); ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke(); }
  if (!data.length) { ctx.fillStyle="#718a85";ctx.font="13px sans-serif";ctx.textAlign="center";ctx.fillText("记录体重后，趋势会显示在这里",w/2,h/2);return; }
  const values=data.map(d=>Number(d.weight)); const min=Math.min(...values)-.5,max=Math.max(...values)+.5; const pad=10;
  const points=values.map((v,i)=>({x:data.length===1?w/2:pad+i*(w-pad*2)/(data.length-1),y:pad+(max-v)/(max-min)*(h-pad*2)}));
  const grad=ctx.createLinearGradient(0,0,0,h);grad.addColorStop(0,"rgba(84,230,177,.32)");grad.addColorStop(1,"rgba(84,230,177,0)");
  ctx.beginPath();ctx.moveTo(points[0].x,h);points.forEach(p=>ctx.lineTo(p.x,p.y));ctx.lineTo(points.at(-1).x,h);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();points.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.strokeStyle="#54e6b1";ctx.lineWidth=2.4;ctx.lineJoin="round";ctx.stroke();
  points.forEach(p=>{ctx.beginPath();ctx.arc(p.x,p.y,3,0,Math.PI*2);ctx.fillStyle="#b6ff72";ctx.fill();});
}

function navigate(page) {
  $$(".page").forEach((el) => el.classList.toggle("active", el.dataset.page === page));
  $$(".nav-item").forEach((el) => el.classList.toggle("active", el.dataset.nav === page));
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (page === "progress") requestAnimationFrame(() => renderProgress());
}
function openModal(id) { $("#" + id).hidden = false; document.body.style.overflow = "hidden"; }
function closeModal(id) { $("#" + id).hidden = true; document.body.style.overflow = ""; }
function toast(message) { const el=document.createElement("div");el.className="toast";el.textContent=message;$("#toastRegion").append(el);setTimeout(()=>el.remove(),2600); }

function fillProfileForm() {
  const p = state.profile || {};
  $("#profileName").value=p.name||""; $("#profileSex").value=p.sex||"female"; $("#profileAge").value=p.age||""; $("#profileHeight").value=p.height||""; $("#profileWeight").value=p.weight||""; $("#profileGoal").value=p.goal||""; $("#profileActivity").value=p.activity||"1.375"; $("#profilePace").value=p.pace||"0.5";
}
function openProfile() { fillProfileForm(); openModal("profileModal"); }

function openMeal(photo = null) {
  pendingPhoto = photo;
  $("#mealForm").reset();
  const h = new Date().getHours(); $("#mealType").value = h < 10 ? "早餐" : h < 16 ? "午餐" : h < 21 ? "晚餐" : "加餐";
  $("#mealPreview").hidden = !photo;
  if (photo) $("#mealPreview").src = URL.createObjectURL(photo);
  $$(".food-chip").forEach((el) => el.classList.remove("active"));
  openModal("mealModal");
}

async function compressImage(file) {
  const bitmap = await createImageBitmap(file); const max=1280; const scale=Math.min(1,max/Math.max(bitmap.width,bitmap.height));
  const canvas=document.createElement("canvas");canvas.width=Math.round(bitmap.width*scale);canvas.height=Math.round(bitmap.height*scale);
  canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
  return new Promise((resolve)=>canvas.toBlob(resolve,"image/jpeg",.74));
}
function escapeHtml(value="") { return String(value).replace(/[&<>'"]/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }

$("#quickFoods").innerHTML = quickFoods.map((f,i)=>`<button class="food-chip" type="button" data-food="${i}">${f.name} · ${f.kcal}</button>`).join("");
$("#quickFoods").addEventListener("click", (event) => {
  const button=event.target.closest("[data-food]");if(!button)return; const food=quickFoods[Number(button.dataset.food)];
  $$(".food-chip").forEach(el=>el.classList.remove("active"));button.classList.add("active");
  $("#mealName").value=food.name;$("#mealCalories").value=food.kcal;$("#mealPortion").value=food.portion;
});

$("#mealForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const data=new FormData(event.currentTarget); const id=crypto.randomUUID(); let photoId=null;
  if(pendingPhoto){photoId=id;try{await photoPut(photoId,pendingPhoto);}catch{toast("照片保存失败，文字记录仍会保留");photoId=null;}}
  state.meals.push({id,date:todayKey(),createdAt:new Date().toISOString(),name:data.get("name").trim(),calories:Number(data.get("calories")),portion:data.get("portion").trim(),type:data.get("type"),photoId});
  saveState(); closeModal("mealModal"); pendingPhoto=null; updateUI(); toast("已记入今天");
});

$("#profileForm").addEventListener("submit", (event) => {
  event.preventDefault(); const data=new FormData(event.currentTarget); const profile=Object.fromEntries(data.entries());
  profile.age=Number(profile.age);profile.height=Number(profile.height);profile.weight=Number(profile.weight);profile.goal=Number(profile.goal);profile.activity=Number(profile.activity);profile.pace=Number(profile.pace);
  if(profile.goal>=profile.weight){$("#profileWarning").hidden=false;$("#profileWarning").textContent="目标体重需要低于当前体重；如果你的目标是维持体重，可以填写略低的短期目标后再调整。";return;}
  state.profile=profile;
  const existingToday=state.weights.find(w=>w.date===todayKey());if(!existingToday)state.weights.push({id:crypto.randomUUID(),date:todayKey(),weight:profile.weight});
  saveState();closeModal("profileModal");updateUI();toast("你的计划已生成");
});

$("#weightForm").addEventListener("submit", (event) => {
  event.preventDefault(); const date=$("#weightDate").value,weight=Number($("#weightInput").value); const existing=state.weights.find(w=>w.date===date);
  if(existing)existing.weight=weight;else state.weights.push({id:crypto.randomUUID(),date,weight});
  if(state.profile && date>=todayKey())state.profile.weight=weight;
  saveState();closeModal("weightModal");updateUI();toast("体重已记录");
});

$("#mealList").addEventListener("click", async (event)=>{const button=event.target.closest("[data-delete-meal]");if(!button)return;const meal=state.meals.find(m=>m.id===button.dataset.deleteMeal);if(!confirm("删除这条饮食记录？"))return;if(meal?.photoId)await photoDelete(meal.photoId);state.meals=state.meals.filter(m=>m.id!==button.dataset.deleteMeal);saveState();updateUI();toast("记录已删除");});
$$('[data-nav]').forEach((button)=>button.addEventListener("click",()=>navigate(button.dataset.nav)));
$$('[data-close]').forEach((button)=>button.addEventListener("click",()=>closeModal(button.dataset.close)));
$$('.modal-backdrop').forEach((backdrop)=>backdrop.addEventListener("click",(event)=>{if(event.target===backdrop)closeModal(backdrop.id);}));
$("#captureButton").addEventListener("click",()=>$("#photoInput").click());
$("#photoInput").addEventListener("change",async(event)=>{const file=event.target.files[0];if(!file)return;try{const blob=await compressImage(file);openMeal(blob);}catch{toast("无法读取这张照片，请换一张试试");}event.target.value="";});
$("#manualAddButton").addEventListener("click",()=>openMeal());
$("#profileButton").addEventListener("click",openProfile);$("#editProfileButton").addEventListener("click",openProfile);
$("#addWeightButton").addEventListener("click",()=>{$("#weightInput").value=state.profile?.weight||"";$("#weightDate").value=todayKey();openModal("weightModal");});
$("#aiInfoButton").addEventListener("click",()=>openModal("infoModal"));
$("#exportButton").addEventListener("click",()=>{const blob=new Blob([JSON.stringify({version:1,exportedAt:new Date().toISOString(),state},null,2)],{type:"application/json"});const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`轻身备份-${todayKey()}.json`;a.click();URL.revokeObjectURL(a.href);toast("备份已导出（照片不包含在内）");});
$("#importInput").addEventListener("change",async(event)=>{const file=event.target.files[0];if(!file)return;try{const parsed=JSON.parse(await file.text());if(!parsed.state||!Array.isArray(parsed.state.meals))throw new Error();if(confirm("恢复备份会覆盖当前文字记录，是否继续？")){state={...defaultState,...parsed.state};saveState();updateUI();toast("备份已恢复");}}catch{toast("这不是有效的轻身备份文件");}event.target.value="";});
$("#clearDataButton").addEventListener("click",async()=>{if(!confirm("确定清除全部资料、饮食和体重记录？此操作无法撤销。"))return;localStorage.removeItem(STORAGE_KEY);try{indexedDB.deleteDatabase(PHOTO_DB);}catch{}state={...defaultState,meals:[],weights:[],completedActions:[]};updateUI();navigate("today");openProfile();toast("本机数据已清除");});

window.addEventListener("beforeinstallprompt",(event)=>{event.preventDefault();deferredInstallPrompt=event;$("#installButton").hidden=false;});
$("#installButton").addEventListener("click",async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$("#installButton").hidden=true;});
window.addEventListener("resize",()=>{if($("#page-progress").classList.contains("active"))renderProgress();});

function registerWebMcp() {
  const context=document.modelContext;if(!context?.registerTool)return;
  const tools=[
    {name:"get_today_summary",title:"查看今日摘要",description:"读取今天的热量目标、已记录热量和剩余热量。",inputSchema:{type:"object",properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:false},execute:()=>{const plan=planFor();const consumed=totalToday();return{date:todayKey(),targetCalories:plan?.calories??null,consumedCalories:consumed,remainingCalories:plan?plan.calories-consumed:null,mealCount:mealsToday().length};}},
    {name:"add_food_record",title:"添加饮食记录",description:"将一条已经确认的食物和热量记录添加到今天。",inputSchema:{type:"object",properties:{name:{type:"string"},calories:{type:"number",minimum:0,maximum:5000},portion:{type:"string"},mealType:{type:"string",enum:["早餐","午餐","晚餐","加餐"]}},required:["name","calories","mealType"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:(input)=>{const validTypes=["早餐","午餐","晚餐","加餐"];if(!input||typeof input.name!=="string"||!input.name.trim()||!Number.isFinite(input.calories)||input.calories<0||input.calories>5000||!validTypes.includes(input.mealType))throw new Error("请提供有效的饮食名称、热量和餐次");const item={id:crypto.randomUUID(),date:todayKey(),createdAt:new Date().toISOString(),name:input.name.trim().slice(0,60),calories:input.calories,portion:typeof input.portion==="string"?input.portion.slice(0,40):"",type:input.mealType,photoId:null};state.meals.push(item);saveState();updateUI();return{status:"saved",record:item};}},
    {name:"add_weight_record",title:"添加体重记录",description:"保存指定日期的一条体重记录。",inputSchema:{type:"object",properties:{date:{type:"string",format:"date"},weightKg:{type:"number",minimum:35,maximum:300}},required:["date","weightKg"],additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute:(input)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(input?.date||"")||!Number.isFinite(input?.weightKg)||input.weightKg<35||input.weightKg>300)throw new Error("请提供有效的日期和 35–300 kg 之间的体重");const item={id:crypto.randomUUID(),date:input.date,weight:input.weightKg};state.weights.push(item);saveState();updateUI();return{status:"saved",record:item};}}
  ];
  tools.forEach(tool=>{try{context.registerTool(tool);}catch{}});
}

if("serviceWorker" in navigator)window.addEventListener("load",()=>navigator.serviceWorker.register("/sw.js").catch(()=>{}));
updateUI();registerWebMcp();
if(!state.profile)setTimeout(openProfile,280);
