export interface SpritesheetData {
  frames: {
    [key: string]: {
      frame: {
        x: number;
        y: number;
        w: number;
        h: number;
      };
      sourceSize: {
        w: number;
        h: number;
      };
      spriteSourceSize: {
        x: number;
        y: number;
      };
    };
  };
  animations: {
    [key: string]: string[];
  };
  meta: {
    scale?: string;
  };
}
