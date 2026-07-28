import type { InstanceStatus, ManagedContainer, ReviewRequestStatus } from "../types";
import ContainerCard from "./ContainerCard";

interface ContainerGridProps {
  containers: ManagedContainer[];
  getContainerTitle: (container: ManagedContainer) => string;
  getContainerReviewRequest: (container: ManagedContainer) => ReviewRequestStatus | null;
  getContainerInstanceStatus: (container: ManagedContainer) => InstanceStatus | null;
  onRefresh: () => void;
}

export default function ContainerGrid({
  containers,
  getContainerTitle,
  getContainerReviewRequest,
  getContainerInstanceStatus,
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
          instanceStatus={getContainerInstanceStatus(container)}
          onRemoved={onRefresh}
        />
      ))}
    </div>
  );
}
