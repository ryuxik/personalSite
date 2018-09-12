import { Injectable } from '@angular/core';
import {BehaviorSubject, Observable} from 'rxjs';

@Injectable({
  providedIn: 'root'
})
export class ContentService {

  private _activeDescriptor: BehaviorSubject<string> = new BehaviorSubject('Home');

  public readonly activeDescriptor: Observable<string> = this._activeDescriptor.asObservable();

  constructor() { }

  updateActive( descriptor : string):void {
  	this._activeDescriptor.next(descriptor);
  }

  getActive(): Observable<string> {
  	return this.activeDescriptor;
  }

}
