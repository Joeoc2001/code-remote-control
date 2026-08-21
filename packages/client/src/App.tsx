import { BrowserRouter, Routes, Route } from "react-router-dom";
import Home from "./pages/Home";
import ContainerLogs from "./pages/ContainerLogs";
import ContainerView from "./pages/ContainerView";
import Tasks from "./pages/Tasks";
import TaskView from "./pages/TaskView";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/logs/:id" element={<ContainerLogs />} />
        <Route path="/view/:id" element={<ContainerView />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/tasks/:id" element={<TaskView />} />
      </Routes>
    </BrowserRouter>
  );
}
