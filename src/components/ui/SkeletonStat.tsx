import { SkeletonText } from './Skeleton';

export function SkeletonStat() {
  return (
    <div className="stat-card">
      <SkeletonText className="h-8 w-20 mb-2" />
      <SkeletonText className="h-4 w-16" />
    </div>
  );
}

export function SkeletonStatGrid({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonStat key={i} />
      ))}
    </div>
  );
}
