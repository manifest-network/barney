import { SkeletonText } from './Skeleton';

export function SkeletonCard() {
  return (
    <div className="card-static p-6">
      <SkeletonText className="h-6 w-32 mb-4" />
      <div className="space-y-3">
        <SkeletonText className="h-4 w-full" />
        <SkeletonText className="h-4 w-3/4" />
        <SkeletonText className="h-4 w-1/2" />
      </div>
    </div>
  );
}

export function SkeletonTable() {
  return (
    <div className="space-y-3">
      {[1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex gap-4 items-center p-3 rounded-lg bg-surface-800/30">
          <SkeletonText className="h-4 w-24" />
          <SkeletonText className="h-4 w-32" />
          <SkeletonText className="h-4 w-20" />
          <SkeletonText className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
