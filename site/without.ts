const without = (refs: ChartRef[], ref: ChartRef) =>
  refs.filter((item) => chartKey(item) !== chartKey(ref))
