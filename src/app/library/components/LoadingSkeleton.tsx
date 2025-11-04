export default function LoadingSkeleton() {
  return (
    <div className="bg-white border-4 border-black shadow-neobrutal p-4">
      <div className="mb-4 space-y-3">
        {/* Search skeleton */}
        <div className="h-10 bg-neobrutal-blue border-4 border-black animate-pulse" />
        
        {/* Filter controls skeleton */}
        <div className="flex gap-3">
          <div className="h-10 w-32 bg-neobrutal-green border-4 border-black animate-pulse" />
          <div className="h-10 w-40 bg-neobrutal-purple border-4 border-black animate-pulse" />
        </div>
      </div>
      
      {/* Games grid skeleton */}
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="text-center p-3 bg-neobrutal-yellow border-4 border-black shadow-neobrutal-sm animate-pulse">
            <div className="w-16 h-16 mx-auto mb-2 bg-neobrutal-pink border-2 border-black" />
            <div className="h-4 bg-neobrutal-blue border-2 border-black mb-2" />
            <div className="h-3 bg-neobrutal-green border-2 border-black w-20 mx-auto" />
          </div>
        ))}
      </div>
    </div>
  );
}
