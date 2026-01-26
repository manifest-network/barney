import { cn } from '../../utils/cn';

interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <div className={cn('skeleton', className)} />;
}

export function SkeletonText({ className }: SkeletonProps) {
  return <div className={cn('skeleton skeleton-text', className)} />;
}

export function SkeletonCircle({ className }: SkeletonProps) {
  return <div className={cn('skeleton skeleton-circle', className)} />;
}
