import { createApp } from "vue";
import App from "./App.vue";
import "./styles/app.css";
import { state, actions, ui } from "./store.js";

const app = createApp(App);
app.mount("#app");

// 开发期调试句柄（生产构建不会执行，因为 import.meta.env.DEV 为 false）
if (import.meta.env && import.meta.env.DEV) {
  window.__MB__ = { state, actions, ui };
}
