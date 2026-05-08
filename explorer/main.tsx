import { createRoot } from "react-dom/client";
import { Explorer } from "./Explorer";

const root = document.getElementById("root");
if (root) createRoot(root).render(<Explorer />);
