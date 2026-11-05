import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../styles/globals.css";
import { ApproveApp } from "../../pages/approve/ApproveApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ApproveApp />
  </StrictMode>,
);
