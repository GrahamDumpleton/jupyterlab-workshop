// SVG files import as their markup, which LabIcon takes as `svgstr`.
declare module '*.svg' {
  const svgstr: string;

  export default svgstr;
}
