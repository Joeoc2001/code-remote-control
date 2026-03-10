import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import ContainerLogs from "./pages/ContainerLogs";
import ContainerView from "./pages/ContainerView";

const basePath = window.__BASE_PATH__ || "";

export default function App() {
  return (
    <BrowserRouter basename={basePath}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/logs/:id" element={<ContainerLogs />} />
        <Route path="/view/:id" element={<ContainerView />} />
      </Routes>
    </BrowserRouter>
  );
}
