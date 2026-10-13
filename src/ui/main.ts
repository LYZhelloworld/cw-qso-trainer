import "./styles.css";
import { App } from "./app.js";

const root = document.getElementById("app");
if (!root) {
  throw new Error("找不到 #app 容器");
}

new App(root).start();
