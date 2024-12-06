export interface SpritesheetData {
  frames: {
    [key: string]: {
      frame: {
        x: number;
        y: number;
        w: number;
        h: number;
      };
    };
  };
  animations: {
    [key: string]: string[];
  };
}