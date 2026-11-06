import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/globals.css";
import { beforeRender } from "../../pages/lib/boot";
import { PopupApp } from "../../pages/popup/PopupApp";

void beforeRender().then(() =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <PopupApp />
    </StrictMode>,
  ),
);
