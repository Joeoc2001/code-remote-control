import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import ContainerLogs from "./pages/ContainerLogs";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/logs/:id" element={<ContainerLogs />} />
      </Routes>
    </BrowserRouter>
  );
}
