import type { ManagedContainer, ReviewRequestStatus } from "../types";
import ContainerCard from "./ContainerCard";

interface ContainerGridProps {
  containers: ManagedContainer[];
  getContainerTitle: (container: ManagedContainer) => string;
  getContainerReviewRequest: (container: ManagedContainer) => ReviewRequestStatus | null;
  onRefresh: () => void;
}

export default function ContainerGrid({
  containers,
  getContainerTitle,
  getContainerReviewRequest,
  onRefresh,
}: ContainerGridProps) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
      {containers.map((container) => (
        <ContainerCard
          key={container.id}
          container={container}
          title={getContainerTitle(container)}
          reviewRequest={getContainerReviewRequest(container)}
          onRemoved={onRefresh}
        />
      ))}
    </div>
  );
}
