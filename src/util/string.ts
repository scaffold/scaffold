export const trunc = (str: string, threshold = 16) =>
  str.length > threshold
    ? `${str.substr(0, threshold)}... [${str.length}]`
    : str;
